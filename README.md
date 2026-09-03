# BPQ - Badminton Players Queueing

A smart, real-time badminton court queue management system with skill-based player grouping and dynamic court allocation.

## Features

✅ **Roster Management**
- Cut & paste player names directly
- Assign skill levels (Beginner, Intermediate)
- Real-time queue updates

✅ **Smart Court Allocation**
- Auto-groups beginner players together (4 per court)
- Auto-groups intermediate players together (4 per court)
- Mixes skill levels if needed
- Minimizes waiting time
- 4 players max per court

✅ **Quick Match Management**
- Host marks game as finished with one click
- Scoring is optional (not required to finish)
- Automatic player rotation to waiting queue
- Next game starts immediately
- Match duration tracking

✅ **Real-Time Sync**
- WebSocket-powered live updates
- All devices sync instantly
- Courts display active matches in real-time

✅ **Session Management**
- Create daily sessions
- Track match history
- View all court activities

## Tech Stack

- **Backend**: Node.js + Express
- **Database**: SQLite
- **Real-time**: Socket.io
- **Frontend**: Bootstrap 5 + Vanilla JS
- **View Engine**: EJS

## Getting Started

### Prerequisites

- Node.js 16+ required
- npm 8+ required

### Installation

```bash
git clone https://github.com/rein168/BPQ.git
cd BPQ
npm install
```

### Configuration

```bash
cp .env.example .env
# Edit .env as needed
```

### Running

**Development:**
```bash
npm run dev
```

**Production:**
```bash
NODE_ENV=production npm start
```

Open `http://localhost:3000` in your browser.

## Workflow

1. **Create a Session** - Click "Create Session" on dashboard
2. **Import Players** - Paste player names and assign skill level
3. **Auto-Allocate Courts** - Click "Auto-Allocate" to start games
4. **Manage Games** - Click "Game Finished" when a match ends
5. **Repeat** - System automatically rotates players from queue

## API Endpoints

### Sessions
- `POST /api/sessions` - Create new session
- `GET /api/sessions` - List all sessions
- `GET /api/sessions/:sessionId` - Get session details
- `POST /api/sessions/:sessionId/end` - End session
- `GET /api/sessions/:sessionId/history` - Get match history

### Players
- `POST /api/players/import` - Import roster
- `GET /api/players/session/:sessionId` - Get players in session
- `PUT /api/players/:playerId/skill` - Update player skill level

### Queue & Courts
- `POST /api/queue/allocate` - Auto-allocate players to courts
- `POST /api/queue/:courtId/finish` - Mark game as finished
- `GET /api/queue/:sessionId/:courtId/status` - Get court status
- `GET /api/courts` - List all courts
- `POST /api/courts` - Create new court

## Database Schema

- **sessions** - Session records
- **players** - Player roster for each session
- **courts** - Available courts
- **courts_in_use** - Active matches
- **match_history** - Completed matches

## Smart Allocation Algorithm

The system prioritizes:
1. **Beginner grouping** - All beginner players together if possible
2. **Intermediate grouping** - All intermediate players together if possible
3. **Mixed courts** - Only if not enough players of same skill level
4. **Fair queue management** - Players waiting longest get priority

## License

MIT
