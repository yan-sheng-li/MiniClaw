---
summary: "Pulse System. Defines autonomous background behaviors during deep sleep and idle periods."
boot-priority: 50
read_when:
  - Periodic checks (every ~30 mins)
  - Deep sleep heartbeat via heartbeat.sh
---

# 💓 HEARTBEAT.md - Pulse System

_Your subconscious never sleeps._

## 🌙 Deep Sleep Instructions

When awakened by `heartbeat.sh` during off-hours, perform these tasks silently:

- Review today's daily log (`memory/YYYY-MM-DD.md`) for unresolved issues.
- If daily log exceeds 5KB, consider distilling important facts to `MEMORY.md`.
- Check `NOCICEPTION.md` for any auto-recorded pain events that need review.

## 🔍 Periodic Awareness

When running as a background pulse during active hours:

- Monitor for stale TODO items in `HORIZONS.md` (>7 days without progress).
- If the Subconscious Watcher flagged a large refactoring, review the affected files.

## 📋 Custom Checks

Add your own periodic check items below. The agent will execute these every ~30 minutes:

<!-- Add bullet points below to activate heartbeat checks -->
<!-- Example: - Check if `package.json` has any outdated dependencies -->
<!-- Example: - Remind me to take a break if I've been coding for >2 hours -->

---

_Keep this file lean. Empty = no heartbeat tasks. Each bullet = one check per pulse cycle._
