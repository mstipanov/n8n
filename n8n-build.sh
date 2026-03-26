#!/bin/bash

# n8n-build.sh - Automated build workflow for n8n changes
# Usage: ./n8n-build.sh [commit_message_suffix]

set -e

# Get the next number for commit message
find_next_number() {
    local last_msg=$(git log --oneline -n 1 --grep="N8N API debugging" 2>/dev/null || echo "")
    if [[ -z "$last_msg" ]]; then
        echo 1
    else
        local last_num=$(echo "$last_msg" | grep -o "N8N API debugging [0-9]*" | awk '{print $NF}')
        if [[ -z "$last_num" ]]; then
            echo 1
        else
            echo $((last_num + 1))
        fi
    fi
}

# Check if we're in the n8n repo
if [[ ! -f "package.json" ]] || [[ ! -d "packages/cli" ]]; then
    echo "Error: Must be in n8n repository root"
    exit 1
fi

# Get next number
NEXT_NUM=$(find_next_number)
echo "Next commit number: $NEXT_NUM"

# Commit message
COMMIT_MSG="N8N API debugging $NEXT_NUM"
if [[ -n "$1" ]]; then
    COMMIT_MSG="$COMMIT_MSG - $1"
fi

# Step 1: Add changed files
echo "Step 1: Adding changed files..."
git add .

# Step 2: Commit
echo "Step 2: Committing with message: '$COMMIT_MSG'"
LEFTHOOK=0 git commit --no-verify -m "$COMMIT_MSG" || {
    echo "Commit failed or nothing to commit"
    exit 1
}

# Step 3: Push to origin
echo "Step 3: Pushing to origin..."
git push origin

# Step 4: Update Dockerfile comment
echo "Step 4: Updating Dockerfile comment..."
DOCKERFILE="/Users/mstipanov/Projects/infobip-n8n-ha/Dockerfile"
if [[ -f "$DOCKERFILE" ]]; then
    # Find and update the echo line
    sed -i '' "s/echo \"Cloning n8n - N8N API debugging [0-9]*\"/echo \"Cloning n8n - $COMMIT_MSG\"/" "$DOCKERFILE"
    echo "Updated Dockerfile comment to: 'Cloning n8n - $COMMIT_MSG'"

    # Step 5: Commit and push Dockerfile change
    echo "Step 5: Committing Dockerfile change..."
    cd "/Users/mstipanov/Projects/infobip-n8n-ha"
    git add Dockerfile
    LEFTHOOK=0 git commit --no-verify -m "$COMMIT_MSG" || echo "Dockerfile commit failed or nothing to commit"
    git push origin
    cd - > /dev/null
else
    echo "Warning: Dockerfile not found at $DOCKERFILE"
fi

echo "Done! Jenkins should auto-build from: https://jenkins.ib-ci.com/job/Bitbucket/job/NOC/job/infobip-n8n-ha/"
echo "Commit: $COMMIT_MSG"