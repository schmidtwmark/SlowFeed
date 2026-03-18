#!/bin/bash

# Slowfeed Cloudflare Tunnel Setup Script
# This script helps you set up a Cloudflare Tunnel to expose Slowfeed to the internet

set -e

echo "=== Slowfeed Cloudflare Tunnel Setup ==="
echo ""

# Check if cloudflared is installed
if ! command -v cloudflared &> /dev/null; then
    echo "cloudflared is not installed."
    echo ""
    echo "To install on macOS:"
    echo "  brew install cloudflare/cloudflare/cloudflared"
    echo ""
    echo "To install on Linux:"
    echo "  curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb"
    echo "  sudo dpkg -i cloudflared.deb"
    echo ""
    exit 1
fi

echo "cloudflared is installed: $(cloudflared --version)"
echo ""

# Check if already logged in
if ! cloudflared tunnel list &> /dev/null; then
    echo "You need to authenticate with Cloudflare first."
    echo "Running: cloudflared tunnel login"
    echo ""
    cloudflared tunnel login
fi

echo ""
echo "=== Creating Tunnel ==="
echo ""

# Prompt for tunnel name
read -p "Enter a name for your tunnel (e.g., slowfeed): " TUNNEL_NAME
TUNNEL_NAME=${TUNNEL_NAME:-slowfeed}

# Create the tunnel
echo "Creating tunnel '$TUNNEL_NAME'..."
cloudflared tunnel create "$TUNNEL_NAME"

# Get tunnel ID
TUNNEL_ID=$(cloudflared tunnel list | grep "$TUNNEL_NAME" | awk '{print $1}')
echo "Tunnel ID: $TUNNEL_ID"

echo ""
echo "=== Setting Up DNS ==="
echo ""

read -p "Enter your domain (e.g., yourdomain.com): " DOMAIN
read -p "Enter the subdomain for Slowfeed (e.g., slowfeed): " SUBDOMAIN
SUBDOMAIN=${SUBDOMAIN:-slowfeed}

HOSTNAME="${SUBDOMAIN}.${DOMAIN}"

echo "Setting up DNS route: $HOSTNAME -> tunnel"
cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME"

echo ""
echo "=== Creating Configuration ==="
echo ""

CONFIG_DIR="$HOME/.cloudflared"
CONFIG_FILE="$CONFIG_DIR/config.yml"

cat > "$CONFIG_FILE" << EOF
tunnel: $TUNNEL_ID
credentials-file: $CONFIG_DIR/$TUNNEL_ID.json

ingress:
  - hostname: $HOSTNAME
    service: http://localhost:3000
  - service: http_status:404
EOF

echo "Configuration written to: $CONFIG_FILE"
echo ""
cat "$CONFIG_FILE"

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Your Slowfeed will be accessible at: https://$HOSTNAME"
echo ""
echo "To start the tunnel manually:"
echo "  cloudflared tunnel run $TUNNEL_NAME"
echo ""
echo "To install as a system service (auto-start on boot):"
echo "  sudo cloudflared service install"
echo ""
echo "Don't forget to update your .env file with:"
echo "  BASE_URL=https://$HOSTNAME"
echo ""
echo "And add https://$HOSTNAME/auth/google/callback to your Google OAuth redirect URIs"
echo ""
