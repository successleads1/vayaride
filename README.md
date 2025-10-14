# Telegram Ride System (Node.js + Socket.IO + MongoDB)

Two Telegram bots:
- **Rider bot**: takes bookings and locations.
- **Driver bot**: drivers go online/offline, update location, accept/reject rides.

Price is estimated from:
- Trip distance (pickup -> destination)
- Driver travel to pickup (driver -> pickup)

## Quick Start

1. **Install deps**
```bash
npm install
```

2. **Configure environment**
Copy `.env.example` to `.env` and fill in:
```
MONGODB_URI=...
TELEGRAM_RIDER_BOT_TOKEN=...
TELEGRAM_DRIVER_BOT_TOKEN=...
BASE_FARE=10
PER_KM=5
PICKUP_PER_KM=2
```

3. **Run**
```bash
npm run dev
```

4. **Driver flow**
- In Telegram, open your **driver bot**.
- `/start`
- `/online`
- Send your **location** (paperclip -> Location). Repeat to update.

5. **Rider flow**
- In Telegram, open your **rider bot**.
- `/start`
- `/book`
- Share **pickup** location, then **destination** location.
- Wait for assignment. Driver gets inline buttons to Accept/Reject.

## Notes
- This uses **polling** for simplicity (no webhook).
- Distance/price via `geolib` (Haversine). Tweak multipliers in `.env`.
- Socket.IO emits `ride:pending` and `ride:accepted` for any optional UI dashboard.
