# Custom Discord RPC

A lightweight local web UI for setting custom Discord Rich Presence statuses on Windows. It detects your open windows, extracts their `.exe` icons automatically, and lets you customize your activity, timestamps, images, and buttons.

## Features
- **Open Window Detection:** Pick any running Windows app to auto-fill details and extract its icon.
- **Full RPC Customization:** Set activity type (Playing, Listening, Watching, Competing), details, state, timestamps, large/small images with tooltips & clickable URLs, and up to 2 buttons.
- **Auto URL Shortening:** Automatically re-hosts image URLs that exceed Discord's 256-character limit.
- **Custom UI Assets:** Upload your own background (PNG, JPG, GIF, WEBP) and profile picture directly from the interface.
- **Built-in Log Viewer:** View status updates and errors inside the UI without checking the terminal.

## Requirements
- **Windows** (uses PowerShell for `.exe` icon extraction)
- **Node.js v20.12+** (for native `.env` support)
- **Discord Desktop App** running in the background

## Setup

1. **Clone the repository**
   ```bash
   git clone [https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git](https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git)
   cd YOUR_REPO_NAME
