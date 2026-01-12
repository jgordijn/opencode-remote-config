#!/bin/bash
set -e

# Fix SSH agent permissions
sudo chmod 666 /run/host-services/ssh-auth.sock

# Install Bun
curl -fsSL https://bun.sh/install | bash
echo 'export PATH="$HOME/.bun/bin:$PATH"' >>~/.zshrc

# Install OpenCode
npm install -g opencode-ai

# Create SSH signing wrapper for 1Password agent compatibility
sudo tee /usr/local/bin/op-ssh-sign >/dev/null <<'EOF'
#!/bin/bash
exec ssh-keygen -U "$@"
EOF
sudo chmod +x /usr/local/bin/op-ssh-sign

# Configure git to include host config but override signing program
cat >~/.gitconfig <<'EOF'
[include]
    path = ~/.gitconfig.host
[gpg "ssh"]
    program = /usr/local/bin/op-ssh-sign
EOF
