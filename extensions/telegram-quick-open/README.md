# Telegram Quick Open

Search your Telegram contacts, groups, and channels directly from Raycast and open any chat instantly in the Telegram app.

## Setup

Before using this extension, you need to get your Telegram API credentials:

1. Go to [my.telegram.org](https://my.telegram.org) and log in with your phone number
2. Click on **API development tools**
3. Create a new application — fill in the required fields (App title, Short name)
4. Copy your **App api_id** and **App api_hash**

## Configuration

Open Raycast Preferences → Extensions → Telegram Quick Open and fill in:

- **Telegram API ID** — the `api_id` from my.telegram.org
- **Telegram API Hash** — the `api_hash` from my.telegram.org
- **Phone Number** *(optional)* — your phone number in international format, e.g. `+84901234567`

## First Run

On the first run you will be prompted to enter your Telegram verification code (sent via SMS or Telegram itself). Your session is stored locally and reused for subsequent searches.

## Usage

Open Raycast, type **Search Telegram**, and start typing a contact or group name. Press `Enter` to open the chat in Telegram immediately.
