# CodeSee Action

A [composite GitHub action](https://docs.github.com/en/actions/creating-actions/creating-a-composite-action) that encapsulates the CodeSee workflow.

## How to use this action

1. Define a new action in your repository by adding a file in the `.github/workflows/` directory. For example:
  
   ```shell
   touch .github/workflows/codesee.yml
   ```

1. Copy the following template into your new workflow file:

    ```yaml
    on:
      push:
        branches:
          - main
      pull_request_target:
        types: [opened, synchronize, reopened]

    name: CodeSee

    permissions: read-all

    jobs:
      codesee:
        runs-on: ubuntu-latest
        continue-on-error: true
        name: Analyse the repo with CodeSee
        steps:
          - uses: Codesee-io/codesee-action@v2
            with:
              codesee-token: ${{ secrets.CODESEE_ARCH_DIAG_API_TOKEN }}
   ```

1. Commit the new workflow to GitHub.
1. That's it! CodeSee will analyze your code to keep your visualizations up to date.
