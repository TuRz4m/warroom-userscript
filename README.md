# TuRzAm WarRoom Connector

A Tampermonkey userscript that enhances the [Torn.com](https://www.torn.com) gaming experience by connecting to the TuRzAm WarRoom service for real-time coordinated faction attacks.

> **Looking for the TornPDA mobile version?** See [README-PDA.md](README-PDA.md)

## 🎯 Overview

This userscript integrates seamlessly with Torn.com to provide faction members with real-time attack coordination capabilities. It displays coordinated attack notifications directly within Torn's interface, allowing faction members to participate in synchronized attacks against targets.

## ✨ Key Features

### Real-Time Attack Notifications
- **Live Attack Feed**: Displays toast notifications for coordinated attacks on the factions page and optionally on attack pages
- **Attack Card Display**: Shows detailed information for each coordinated attack including:
  - Target name and ID
  - Attack status (Active/Full)
  - Countdown timer with urgent warnings (under 1 minute)
  - Participant slots (filled/total)
  - List of participating members
  - Attack creator information

### Attack Management
- **Join Attacks**: One-click join functionality for available coordinated attacks
- **Create Coordinated Attacks**: Create new coordinated attacks when viewing a target from your faction's war room list
- **Mark as Done**: Mark attacks as complete when finished
- **Direct Attack Links**: Quick access to attack pages for joined attacks
- **Auto-Hide Full Attacks**: Automatically removes full attacks from the feed (configurable)

### Attack Creation
When viewing a target's attack page (via `https://www.torn.com/loader.php`), if the target is in your faction's war room target list, you can create a coordinated attack with:
- Custom number of participants (1-30)
- Expiration time (1-15 minutes)
- Option to wait until full before showing attack link
- Creator automatically joins the attack

### Ranked War Stats
On the faction ranked war page (`/factions.php?step=your#/war/rank`):
- **Limits Display**: Shows current war limits (hits, total respect, average respect goals)
- **Member Stats**: Displays each member's war hits and average respect
- **Compliance Coloring**: Green for compliant, red for non-compliant stats
- **Auto-Refresh**: Stats cached until next update from server

### Smart Notifications
- **Visual Countdown Timer**: Real-time countdown for each attack with urgent highlighting when time is running low
- **Sound Alerts**: Optional audio notification when new attacks are created (configurable)
- **Status Badges**: Visual indicators for attack status (Active/Full)
- **Automatic Expiration**: Attacks are automatically removed when expired

### Customizable Settings
Access the settings panel to configure:
- **API Key**: Your WarRoom authentication key
- **Attack Feed Toggle**: Enable/disable attack notifications on faction page
- **Attack Page Feed**: Show/hide notifications on attack pages (loader.php)
- **Auto-Hide Full Attacks**: Automatically hide attacks when they reach capacity
- **Sound Notifications**: Enable/disable audio alerts for new attacks
- **Button/Toast Position**: Choose corner placement (bottom-left, bottom-right, top-left, top-right)
- **Target Cache Management**: Clear cached war room target data
- **Token Management**: Clear authentication tokens when needed

### User Interface
- **Non-Intrusive Toast Notifications**: Stylish, glassmorphic toast cards
- **Floating Action Buttons**: Quick access buttons for:
  - Attack feed toggle (enable/disable notifications)
  - Settings configuration
  - Create coordinated attack (on attack pages with valid targets)
- **Modern Design**: Purple-themed UI with smooth animations and transitions
- **Configurable Position**: Place buttons and toasts in any corner

## 📋 Requirements

- [Tampermonkey](https://www.tampermonkey.net/) browser extension (or compatible userscript manager)
- Active account on [Torn.com](https://www.torn.com)
- TuRzAm WarRoom API key (obtainable from [torn.zzcraft.net](https://torn.zzcraft.net))
- Faction membership with access to war rooms

## 🚀 Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser
2. Click on the Tampermonkey icon and select "Create a new script"
3. Copy the contents of `warroom.user.js` and paste it into the editor
4. Save the script (Ctrl+S or Cmd+S)
5. The script will automatically activate on Torn.com

## ⚙️ Configuration

1. Navigate to any Torn.com page where the script is active
2. Click the settings button (gear icon) in the corner
3. Enter your WarRoom API key in the API Key field
4. Configure your preferences:
   - Enable/disable attack feed on faction page
   - Enable/disable attack feed on attack pages
   - Toggle auto-hide for full attacks
   - Enable/disable sound notifications
   - Choose button/toast position
5. Click "Save" to apply your settings
6. Refresh the page for changes to take full effect

## 📖 Usage

### Viewing Coordinated Attacks
1. Navigate to the Factions page (`https://www.torn.com/factions.php`)
2. Active coordinated attacks will appear as toast notifications
3. Each attack card shows:
   - Target information
   - Time remaining
   - Current participants
   - Available slots

### Joining an Attack
1. Click the "Join" button on any available attack notification
2. You'll receive a confirmation message
3. The attack card will update to show you as a participant
4. Once joined, you'll see the "Attack" button to access the target

### Creating a Coordinated Attack
1. Navigate to attack a target via the attack interface (which uses loader.php)
2. If the target is in your faction's war room list, a green plus button appears
3. Click the button to open the attack creation dialog
4. Configure the attack parameters:
   - Number of participants needed
   - Expiration time in minutes
   - Whether to wait until full before showing the link
5. Click "Create Attack" to broadcast to your faction

### Marking Attacks as Complete
1. Click the "Done" button on any attack you're participating in
2. The attack will be removed from all participants' feeds

### Toggling the Attack Feed
1. Click the bell icon to enable/disable notifications
2. When enabled, the bell is purple
3. When disabled, the bell is red with a line through it

### Viewing Ranked War Stats
1. Navigate to Factions → Your Faction → War → Ranked War
2. The limits bar appears below the faction info showing current requirements
3. Each member row displays hits and average respect with compliance coloring

## 🔧 Technical Details

### Permissions & Grants
- `GM_xmlhttpRequest` / `GM.xmlHttpRequest`: For API communication bypassing CSP
- `GM_addStyle`: Inject custom CSS for the user interface
- `GM_getValue` / `GM_setValue`: Store settings and authentication tokens
- Connection to `api.torn.zzcraft.net`: WarRoom service API

### Matched Pages
The script automatically runs on:
- `https://www.torn.com/loader.php*` - Attack pages for target detection and coordinated attack creation
- `https://www.torn.com/factions.php*` - Faction pages where the attack feed is displayed

### Architecture
- **SignalR Long Polling**: Custom implementation for real-time communication
- **JWT Token Management**: Automatic token storage, validation, and renewal
- **Event-Driven Updates**: Listens for attack events (Added, Updated, Done, Removed)
- **Timer Management**: Individual countdown timers for each active attack
- **Cache Layer**: 1-hour TTL cache for war room targets
- **Reconnection Logic**: Exponential backoff retry (up to 5 attempts)

### API Endpoints
| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/auth/login` | Login with API key |
| GET | `/warrooms/targets` | Get all war room targets |
| POST | `/WarRooms/{id}/attack` | Create coordinated attack |
| POST | `/WarRooms/participate/{attackId}` | Join attack |
| POST | `/WarRooms/end/{attackId}` | Mark attack as done |
| GET | `/rankedwars/last` | Get ranked war stats |

## 🛡️ Security

- All user input is sanitized using HTML escaping to prevent XSS attacks
- JWT tokens are stored securely using Tampermonkey's GM_getValue/GM_setValue
- Token expiration is checked before each request with 5-minute buffer
- Failed authentication attempts clear stored tokens
- API communication uses HTTPS only

## 🎨 User Interface

The userscript features a modern, dark-themed interface with:
- **Glassmorphic Design**: Semi-transparent cards with backdrop blur
- **Purple Accent Color**: Consistent branding with #9b59b6 primary color
- **Smooth Animations**: Slide-in/slide-out transitions for notifications
- **Responsive Layout**: Adapts to different screen sizes
- **Accessibility**: High contrast text and clear visual indicators

## 🐛 Troubleshooting

### No Attack Notifications Appearing
1. Check that attack feed is enabled (bell icon should be purple)
2. Verify your API key is configured in settings
3. Ensure you're a member of a faction with active war rooms
4. Check browser console for error messages

### Authentication Errors
1. Verify your API key is correct
2. Clear the authentication token in settings
3. Reload the page to re-authenticate

### Attacks Not Updating
1. Check your internet connection
2. The script will attempt automatic reconnection
3. If persistent, clear token and reload the page

### Cache Issues
1. Use the "Clear Cache" button in settings to reset target cache
2. This forces a fresh fetch of war room targets

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 👤 Author

**TuRzAm** (GitHub: [@TuRz4m](https://github.com/TuRz4m))
- Website: [torn.zzcraft.net](https://torn.zzcraft.net/)

## 🔗 Related Links

- [Torn.com](https://www.torn.com) - The browser-based crime game
- [Tampermonkey](https://www.tampermonkey.net/) - Userscript manager
- [TornPDA Version](README-PDA.md) - Mobile version for TornPDA app
- [WarRoom Service](https://torn.zzcraft.net/) - Get your API key

## 📝 Version

Current Version: **1.1.1**

---

*This is a third-party userscript and is not officially affiliated with or endorsed by Torn.com*
