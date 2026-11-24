# discord-ticketbot

Discord bot for a community support team: tickets, role management, time-limited reaction roles, voice waiting-room pings and a ban log. All configuration lives in MariaDB and is picked up at runtime, so changing a category or a role does not need a restart.

Node.js, discord.js 14, MariaDB (mysql2), `node:test`.

## Features

- Tickets: a panel with one button per category. Each ticket is a private channel that only the user, the admins and the category's default roles can see. Team members can pull in a subteam from a select menu. On close the transcript goes to an archive channel, to the user via DM and into the database.
- Role management: `/add` and `/remove` let manager roles hand out a fixed set of roles, nothing else.
- Reaction roles: a button to claim a role, optionally only inside a daily time window, with a required role and a minimum account age. The team gets a warning ten minutes before the window closes and can extend it by 30 or 60 minutes.
- Voice pings: joining a waiting room pings the responsible roles.
- Ban log: a panel with predefined reasons plus `/banreason` for free text, confirmed in a second step, posted to an output channel.
- Hot reload: polls a change log every 15 s and only rebuilds panels and slash commands when something changed. A broken config never takes down a running bot, the error ends up in a status row.

## Setup

```bash
cp .env.example .env                        # token + db credentials
cp seed/config.example.json seed/config.json
npm ci
npm start
```

On the first start the bot creates its tables (`lib/schema.sql`) and imports `seed/config.json` if the config tables are still empty. After that the database is the source of truth and the file is ignored.

`deploy/create-db-user.sql` creates a database user that can only touch the bot's own tables.

Old file-based transcripts (`<user>_<ddMMyyyyHHmmss>_<category>.txt`) can be imported with `node scripts/import-transcripts.js <dir>`, or by dropping them into `seed/transcripts/` before the first start.

## Configuration

| Key in `seed/config.json` | What it does |
| --- | --- |
| `guildId`, `teamRoleId`, `adminRoleIds` | Server and who counts as team |
| `userRoleId` | Optional. `/add` only works on members that have this role |
| `ticketChannelId`, `archiveChannelId`, `categories` | Ticket panel, transcript archive, one entry per ticket category |
| `subteams` | Groups the team can add to a ticket |
| `roleCommandChannelId`, `roleManagement` | Who may assign which roles via `/add` / `/remove` |
| `voiceNotificationChannelId`, `voiceGroups` | Waiting rooms and the roles to ping |
| `reactionLogChannelId`, `reactionRoles` | Reaction roles, optional `startTime` / `endTime` (`HH:MM`), `requiredRoleId`, `minAccountAgeDays` |
| `banLog` | Input/output channel and the list of reasons |

In the database these map to `ticketbot_settings` (key/value) and one table per list.

## Making it yours

Some things are specific to the server this was built for:

| What | Default | Where |
| --- | --- | --- |
| Language | English, German included | `BOT_LOCALE=en\|de`, strings in `locales/*.json`. Add a language by copying `en.json`, missing keys fall back to English |
| Timezone | Europe/Berlin, for ticket names and reaction-role windows | `TIMEZONE` in `index.js`, `TZ` in `Dockerfile` |
| Date format in logs | follows the locale (`dateLocale`) | `locales/*.json` |
| Ticket visibility | The team role can write in tickets but only sees them through a category or subteam role | permission overwrites in `createTicket` (`index.js`) |
| Who may extend reaction roles | Team, admins and the subteams named `support` / `moderation` | `EXTEND_SUBTEAMS` in `index.js` |
| Inactivity note on close | 3 days | `INACTIVE_MS` in `index.js` |
| Config editing | No UI included. It was maintained through a separate admin panel that writes to the `ticketbot_*` tables | Edit via SQL or build your own UI |
| Change detection | Reads the highest `id` from `config_change_log` (`id`, `table_name`) for rows starting with `ticketbot_`. Without that table the config is loaded once at startup | `readChangeId` in `lib/config-db.js` |

If you write your own admin UI, insert a row into `config_change_log` on every change and the bot picks it up within 15 seconds.

## Tests

```bash
npm test
TEST_DATABASE_URL=mysql://root:pw@localhost:3306 npm test   # also runs the db tests
```

The db tests create a throwaway database with a random name and drop it afterwards.

## Deployment

`Dockerfile` builds a plain `node:20-alpine` image, no ports. Run exactly one instance per bot token, otherwise Discord delivers every interaction twice.

## License

MIT
