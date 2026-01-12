#!/bin/bash
# Start the devcontainer for this project

if ! command -v devcontainer &>/dev/null; then
	echo "Installing @devcontainers/cli..."
	npm install -g @devcontainers/cli
fi

devcontainer up --workspace-folder .
devcontainer exec --workspace-folder . zsh
