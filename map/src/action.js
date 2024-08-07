const fs = require("fs");
const core = require("@actions/core");
const exec = require("@actions/exec");
const insightsAction = require("./insights");

/**
 * Asynchronously reads the contents of a file.
 * @param {string} filePath - The path of the file you want to read.
 * @returns {Promise<string>} The contents of the file as a string.
 */
async function readFile(filePath) {
  return new Promise((resolve, reject) => {
    fs.readFile(filePath, { encoding: "utf-8" }, (err, data) => {
      if (err) {
        return reject(err);
      }
      resolve(data.toString());
    });
  });
}

function setupEnv() {
  core.setSecret("api_token");
}

function isPullRequestEvent(githubEventName) {
  // We currently listen for "pull_request_target" since that will allow secrets
  // to be passed in for forked repos, but we used to listen for "pull_request",
  // so we keep it here for backwards compatibility.
  return (
    githubEventName === "pull_request" ||
    githubEventName === "pull_request_target"
  );
}

function isForkedPullRequestEvent(githubEventName, githubEventData) {
  return (
    isPullRequestEvent(githubEventName) &&
    githubEventData.pull_request.head.repo.fork
  );
}

function isInsecureConfiguration(config) {
  // This checks to see if we are in an insecure configuration.
  // If we are running maps, there is a possibility that user-supplied
  // code may run. This is only possible with Python right now.
  // If that happens, we want to disable Python so this check allows
  // us to check if that situation is present.
  return config.apiToken && config.languages.python;
}

const INSIGHTS_DISABLED = "Insights Disabled";

async function needsInsights(config) {
  const args = [
    "codesee@latest",
    "metadata",
    "--repo",
    config.repoOrigin,
    "-a",
    config.apiToken,
    "-o",
    "codesee.metadata.json",
  ];

  if (config.codeseeUrl) {
    args.push("--url", config.codeseeUrl);
  }

  const runExitCode = await exec.exec("npx", args);
  if (runExitCode !== 0) {
    // If we can't get the metadata, assume that we need insights!
    return true;
  }

  try {
    const output = JSON.parse(
      await fs.promises.readFile("codesee.metadata.json", "utf-8")
    );
    if (output.insightsDisabled) {
      return INSIGHTS_DISABLED;
    }
    return output.insights.length === 0;
  } catch (e) {
    core.warning(
      `\n\n Unable to read metadata for repo, assuming we need insights: ${e.message}`
    );
    return true;
  }
}

function getBooleanInput(paramName) {
  return ["true", "True", "TRUE"].includes(process.env[paramName])
    ? true
    : false;
}

function getConfig() {
  const apiToken = process.env["api_token"];

  const webpackConfigPath = process.env["webpack_config_path"];

  const supportTypescript = getBooleanInput("support_typescript");

  const skipUpload = getBooleanInput("skip_upload");

  const step = process.env["step"] || "legacy";

  const languagesEnv = process.env["languages"];
  const languages = languagesEnv ? JSON.parse(languagesEnv) : "{}";

  const eventDataPath =
    process.env["with_event_data"] || process.env.GITHUB_EVENT_PATH;

  const eventName =
    process.env["with_event_name"] || process.env.GITHUB_EVENT_NAME;

  const codeseeUrl = process.env["codesee_url"];

  /**
   * The owner and repository name. For example, "octocat/Hello-World". This
   * environment variable seems to have the correct value for both branch PRs
   * and fork PRs (this needs to be the base repo, not the fork repo).

   * @see https://docs.github.com/en/actions/learn-github-actions/variables#default-environment-variables
   **/
  const repoFullName = process.env.GITHUB_REPOSITORY;

  /**
   * Returns the URL of the GitHub server. For example, "https://github.com"
   *
   * @see https://docs.github.com/en/actions/learn-github-actions/variables#default-environment-variables
   **/
  const githubOrigin = process.env.GITHUB_SERVER_URL;

  const repoOrigin = githubOrigin + "/" + repoFullName;

  // UNIX convention is that command line arguments should take precedence
  // over environment variables. We're breaking from this convention below
  // because when this action runs on a pull request, we want to use the
  // value of process.env.GITHUB_HEAD_REF in preference to the input
  // github_ref. The value in github_ref is also available in
  // process.env.GITHUB_REF, but it may be an error to pass an input in to
  // an action that is not used.
  // TODO: CODESEE-1474 see if we can avoid getting github_ref from our inputs.
  const githubRef = process.env.GITHUB_HEAD_REF || process.env["github_ref"];
  const githubBaseRef = process.env.GITHUB_BASE_REF;

  return {
    apiToken,
    webpackConfigPath:
      webpackConfigPath === "__NULL__" ? undefined : webpackConfigPath,
    supportTypescript,
    repoFullName,
    githubOrigin,
    repoOrigin,
    githubBaseRef,
    githubRef,
    skipUpload,
    languages,
    eventDataPath,
    eventName,
    codeseeUrl,
    step,
    ...insightsAction.getConfig(),
  };
}

// We need to checkout the HEAD ref because the actions/checkout@v2 action
// checks out the GitHub ref for the pull request, which is pull/<number>/merge.
// This ref points to a merge commit that's on top of the user's actual commits.
// This is important because if you use `git rev-parse HEAD`, you'll get a
// commit SHA that's different than the HEAD SHA. This difference causes issues
// downstream (e.g. when commenting diagram images to PRs).
async function checkoutHeadRef({ githubRef }) {
  const runExitCode = await exec.exec("git", ["checkout", githubRef]);
  if (runExitCode !== 0) {
    throw new Error(
      `git checkout ${githubRef} failed with exit code ${runExitCode}`
    );
  }
}

async function getEventData(githubEventName, eventDataPath) {
  let githubEventData = {};

  try {
    githubEventData = JSON.parse(await readFile(eventDataPath));
  } catch (e) {
    // No-op, we just return empty githubEventData
  }

  return { githubEventName, githubEventData };
}

async function runCodeseeMap(config, excludeLangs) {
  const args = ["codesee@latest", "map", "-o", "codesee.map.json"];
  if (excludeLangs && excludeLangs.length > 0) {
    args.push("-x", excludeLangs.join(","));
  }

  if (config.webpackConfigPath) {
    args.push("-w", config.webpackConfigPath);
  }
  if (config.supportTypescript) {
    args.push("--typescript");
  }
  if (config.apiToken) {
    args.push("-a", config.apiToken);
  }
  if (config.languages) {
    args.push("--languages", JSON.stringify(config.languages));
  }

  if (config.codeseeUrl) {
    args.push("--url", config.codeseeUrl);
  }

  args.push("--repo", config.repoOrigin);

  args.push(process.cwd());
  const runExitCode = await exec.exec("npx", args);

  return runExitCode;
}

async function runCodeseeMapUpload(config, githubEventName, githubEventData) {
  const additionalArguments = config.githubRef ? ["-f", config.githubRef] : [];

  if (isPullRequestEvent(githubEventName)) {
    additionalArguments.push("-b", config.githubBaseRef);
    additionalArguments.push("-s", githubEventData.pull_request.base.sha);
    additionalArguments.push("-p", githubEventData.number.toString());
  }

  const args = [
    "codesee@latest",
    "upload",
    "--type",
    "map",
    "--repo",
    config.repoOrigin,
    "-a",
    config.apiToken,
    ...additionalArguments,
    "codesee.map.json",
  ];

  if (config.codeseeUrl) {
    args.push("--url", config.codeseeUrl);
  }

  const runExitCode = await exec.exec("npx", args);

  return runExitCode;
}

async function setup() {
  core.startGroup("Setup");
  setupEnv();
  const config = getConfig();
  core.debug("CONFIG: ");
  core.debug(config);

  await core.group("Checkout HEAD Ref", async () => checkoutHeadRef(config));

  const { githubEventName, githubEventData } = await getEventData(
    config.eventName,
    config.eventDataPath
  );
  core.endGroup();

  return { config, githubEventName, githubEventData };
}

async function generate(data) {
  const { config, githubEventName, githubEventData } = data;

  await core.group("Generate Map Data", async () => {
    const excludeLangs = [];
    if (
      isForkedPullRequestEvent(githubEventName, githubEventData) &&
      isInsecureConfiguration(config)
    ) {
      core.info(
        "Detected Forked PR with potential insecure configuration, disabling python"
      );
      core.info(
        "Consider updating your workflow to the latest version from CodeSee."
      );
      excludeLangs.push("python");
    } else if (isPullRequestEvent(githubEventName)) {
      core.info("Detected no insecure configuration, allowing all languages");
    }
    return await runCodeseeMap(config, excludeLangs);
  });
}

async function upload(data) {
  const { config, githubEventName, githubEventData } = data;

  if (config.skipUpload) {
    core.info("Skipping map upload");
  } else {
    await core.group("Upload Map to Codesee Server", async () =>
      runCodeseeMapUpload(config, githubEventName, githubEventData)
    );
  }
}

async function insights(data) {
  const { config, githubEventName } = data;

  if (isPullRequestEvent(githubEventName)) {
    core.info("Running on a pull request so skipping insight collection");
    return;
  }

  const insightsNeeded = await needsInsights(config);
  if (insightsNeeded === INSIGHTS_DISABLED) {
    return;
  }

  await insightsAction.run(config);
}

async function requireApiToken(data) {
  if (!data.config.apiToken) {
    core.warning(
      "\n\n===============================\nError accessing your API Token.\nPlease make sure the CODESEE_ARCH_DIAG_API_TOKEN is set correctly in your *repository* secrets (not environment secrets).\nIf you need a new API Token, please go to app.codesee.io/maps and create a new map.\nThis will generate a new token for you.\n===============================\n\n"
    );
    throw new Error("Api Token Required to continue");
  }
}

async function main() {
  const stepMap = new Map([
    ["map", [generate]],
    ["mapUpload", [requireApiToken, upload]],
    ["insights", [requireApiToken, insights]],
    ["legacy", [requireApiToken, generate, upload, insights]],
  ]);
  const data = await setup();
  const step = data.config.step;

  if (!stepMap.has(step)) {
    core.error(
      `Unable to find run configuration for ${step}. Should be one of ${[
        ...stepMap.keys(),
      ].join(", ")}`
    );
    return;
  }

  for (const stepFunc of stepMap.get(step)) {
    core.info(`Running step ${stepFunc.name}`);
    await stepFunc(data);
  }
}

main()
  .then(() => {})
  .catch((err) => {
    core.info(`CodeSee Map failed: ${err}
    ${err.stack}`);
  });
