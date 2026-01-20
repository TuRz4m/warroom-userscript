# TuRzAm WarRoom Connector - TornPDA Version

A mobile userscript for [TornPDA](https://github.com/Manuito83/torn-pda) that brings real-time coordinated attack notifications to your mobile device.

> **Looking for the desktop Tampermonkey version?** See [README.md](README.md)

## 🎯 Overview

This is the TornPDA-compatible version of the WarRoom Connector. It provides the same core functionality as the desktop version but uses TornPDA's native HTTP API for communication.

## ✨ Features

### Core Functionality
- **TornPDA Environment Detection** - Automatically detects and runs only in TornPDA
- **JWT Authentication** - Secure authentication with token caching via localStorage
- **SignalR Long-Polling** - Real-time connection to WarRoom API
- **Mobile-Optimized Toast Notifications** - Touch-friendly attack alerts with countdown timers
- **Attack Details** - Shows target, timer, participants, and creator
- **Urgency Indicators** - Red pulsing timer for attacks with <1 minute remaining

### Interactive Features
- **Join/Attack/Done Buttons** - Take action directly from attack notifications
- **Create Coordinated Attacks** - Request attacks on targets from loader.php pages
- **Feed Toggle Button** - Enable/disable attack notifications on the fly
- **Settings Panel** - Configure toast position, auto-hide, and feed status
- **Target Detection** - Auto-detects war room targets on attack pages

### Ranked War Stats
On the faction ranked war page (`/factions.php?step=your#/war/rank`):
- **Limits Display** - Shows current war limits (hits, total respect, average respect goals)
- **Member Stats** - Displays each member's war hits and average respect
- **Compliance Coloring** - Green for compliant, red for non-compliant stats
- **Auto-Refresh** - Stats cached until next update from server

## 📋 Requirements

- [TornPDA](https://github.com/Manuito83/torn-pda) mobile application
- Active account on [Torn.com](https://www.torn.com)
- Faction membership with access to war rooms

## 🚀 Installation

1. **Add Script to TornPDA**:
   - Open TornPDA app
   - Go to **Settings** → **Userscripts**
   - Add new userscript
   - Copy the contents of `warroom-pda.user.js`
   - Paste into TornPDA userscript editor

2. **Configure API Key**:
   - In TornPDA, go to **Settings** → **API Key**
   - Enter your Torn API key
   - The script will automatically use this key (via the `###PDA-APIKEY###` pattern)

3. **Enable Script**:
   - Ensure the script is enabled in TornPDA userscripts settings
   - Navigate to any Torn.com page
   - The script will initialize automatically

## ⚙️ Configuration

Click the **gear icon** to open settings:

| Setting | Description |
|---------|-------------|
| **Toast Position** | Choose where notifications appear (bottom-left, bottom-right, top-left, top-right) |
| **Attack Feed** | Enable/disable real-time attack notifications |
| **Auto-hide Full Attacks** | Automatically remove toasts when attacks fill up |
| **Clear Cache** | Clear target cache (forces refresh) |
| **Clear Token** | Force re-authentication |

## 📖 Usage

### Viewing Coordinated Attacks

When a coordinated attack is created or updated, a toast notification appears with:

- **Target Information**: Name and ID
- **Status Badge**: "Active" (green) or "Full" (orange)
- **Live Countdown Timer**: Updates every second
  - Normal: White timer
  - Urgent (<1 min): Red pulsing timer
- **Participant Count**: Shows filled/total slots
- **Participant List**: Names of joined attackers
- **Action Buttons**:
  - **Join** - Join the attack (if not full and you haven't joined)
  - **Attack** - Opens attack link (if you've joined)
  - **Done** - Mark attack as complete (if you're a participant or creator)
- **Creator Info**: Shows who created the attack
- **Auto-Expiration**: Toast auto-removes when timer expires

### Creating Coordinated Attacks

When viewing a war room target on loader.php pages:

1. **Green "+" Button** appears in the top area
2. **Click to Open Dialog** with options:
   - Target (auto-filled from detected target)
   - Number of People Needed (1-30)
   - Expiration (1-15 minutes)
   - Wait Until Full toggle
3. **Create Attack** - Broadcasts to all war room members

### Feed Toggle

**Bell Icon** in the top area:
- **Purple Bell** - Feed is ON, receiving attack notifications
- **Red Bell with Cross** - Feed is OFF, not receiving notifications
- **Tap to Toggle** - Instantly connect/disconnect from WarRoom
- **Persistent** - Setting saved across sessions

## 🔄 Differences from Desktop Version

| Feature | Desktop | TornPDA |
|---------|---------|---------|
| HTTP Requests | `GM.xmlHttpRequest` | `flutter_inappwebview.callHandler` |
| API Key | Manual entry in settings | Auto-injected as `###PDA-APIKEY###` |
| Storage | `GM_getValue`/`GM_setValue` | `localStorage` |
| Sound Notifications | Supported | Not supported |
| Button Positions | Configurable (4 corners) | Fixed top positions |
| DELETE Requests | Supported | Not supported (skipped silently) |

## 🔧 Technical Details

### API Key Pattern

The script uses TornPDA's automatic API key injection:

```javascript
const API_KEY = "###PDA-APIKEY###";
```

**Important**:
- Do NOT modify this line
- TornPDA automatically replaces `###PDA-APIKEY###` with your configured API key at runtime
- If you see authentication errors, check your TornPDA API key settings

### Architecture

- **Platform**: TornPDA userscript
- **Authentication**: JWT tokens (5-min expiry buffer)
- **Communication**: SignalR long-polling over HTTP via PDA's Flutter handlers
- **Storage**: localStorage for token and settings persistence
- **UI**: Custom mobile-optimized toast cards with CSS animations
- **Target Detection**: Cached war room targets (1-hour TTL)

### API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/auth/login` | Login with API key |
| GET | `/warrooms/targets` | Get all war room targets |
| POST | `/WarRooms/{id}/attack` | Create coordinated attack |
| POST | `/WarRooms/participate/{id}` | Join an attack |
| POST | `/WarRooms/end/{id}` | Mark attack as done |
| GET | `/rankedwars/last` | Get ranked war stats |

### SignalR Hub Methods

| Method | Type | Purpose |
|--------|------|---------|
| `SetDisplayName` | Send | Identify client as "TornPDA" |
| `GetWarRooms` | Invoke | Fetch available war rooms |
| `GetAttacks` | Invoke | Fetch attacks for war room |
| `AttackUpdate` | Receive | Real-time attack events |
| `WarRoomAttacks` | Receive | Bulk attack data |

### Matched Pages

- `https://www.torn.com/*` - All Torn.com pages (broader match for PDA compatibility)

## 🐛 Troubleshooting

### Script Not Starting

- Verify script is enabled in TornPDA settings
- Check userscript match pattern includes `https://www.torn.com/*`
- Reload Torn.com page in TornPDA

### Authentication Errors

- Verify your API key is configured in TornPDA settings
- Use "Clear Token" in settings to force re-authentication
- Reload the page

### No Attack Notifications

- Check that attack feed is enabled (bell icon should be purple)
- Ensure you're a member of a faction with active war rooms
- Try toggling the feed off and on

### Attacks Not Updating

- Check your internet connection
- The script will attempt automatic reconnection (up to 5 times)
- If persistent, clear token and reload

### Console Logging

The script logs debug information to the console:

```
[WarRoom:Auth] Logging in with API key
[WarRoom:Auth] Login successful
[WarRoom:SignalR] Starting connection
[WarRoom:SignalR] Negotiated {connectionId: "..."}
[WarRoom:Main] SignalR connected
[WarRoom:Main] WarRooms received [...]
```

To view logs, use TornPDA's developer console or remote debugging via Chrome DevTools.

## ⚠️ Known Limitations

- **No Sound Notifications** - Silent notifications only (TornPDA limitation)
- **Fixed Button Positions** - Uses absolute positioning in top area
- **No DELETE Requests** - PDA doesn't support DELETE method (handled gracefully)
- **Reconnection Limit** - Attempts up to 5 reconnects with exponential backoff
- **Cache Duration** - Target cache expires after 1 hour

## 📄 License

Same as desktop version - MIT License. See [LICENSE](LICENSE) for details.

## 👤 Author

**TuRzAm** (GitHub: [@TuRz4m](https://github.com/TuRz4m))
- Website: [torn.zzcraft.net](https://torn.zzcraft.net/)

## 🔗 Related Links

- [Desktop Version](README.md) - Tampermonkey version for browsers
- [TornPDA](https://github.com/Manuito83/torn-pda) - Mobile companion app
- [WarRoom Service](https://torn.zzcraft.net/) - Get your API key
- [Torn.com](https://www.torn.com) - The browser-based crime game

## 📝 Version

Current Version: **1.0.0**

---

*This is a third-party userscript and is not officially affiliated with or endorsed by Torn.com or TornPDA*
