# Changelog

## v1.1

- Email a "vent" to a Gmail plus-address (labeled `CalBot`) or text it from an iPhone Shortcut (`cal:` prefix); Gemini turns it into Google Calendar events.
- Default reminders 5 / 2 / 1 days before, plus per-item reminders and notes stated in the message.
- Color-coded by category; anything due today or tomorrow turns red; uncertain items turn blue.
- Undated tasks land on the same day at 8pm.
- "Done / finished / submitted" turns an item grey and moves it to a finished section; undo, move, and cancel are supported. Moving a deadline resets its reminders. Nothing is ever deleted.
- Update matching is done in code (fuzzy match, soonest upcoming item wins), so "done with hw" picks the assignment due soonest rather than an old one.
- Daily 5pm email digest of the next 14 days.
- Items the bot can't place are logged as "event denied" for review.
