# CalBot: vent your week, get your calendar

Hate adding things to Google Calendar? Don't. Just rant.

> "omg this week is a lot. hydro HW due tuesday, all 3 parts, remind me an hour before.
> thermo exam thursday at 2pm. and I need to email my TA about my grade"

CalBot reads that, works out what's due and when, and puts it on your calendar: color-coded,
with reminders, plus a daily 5pm email of what's coming up.

![A messy text becoming calendar events](docs/images/00-demo.gif)

## What it does
- Turns a messy paragraph into clean calendar events (text it from your iPhone)
- Color-codes by importance: exams, labs, and projects red; homework yellow; errands green;
  jobs and internships purple; anything unsure blue
- "done with hydro HW" turns it grey and stops reminders
- Handles moved, cancelled, and un-done items, and never deletes anything
- To-dos with no date land at 8pm that day
- Daily 5pm digest of the next 14 days, plus a list of what you've finished

## How it works
Your text goes to a small script running in **your own Google account**, which asks Gemini to
read it and then writes to **your own Google Calendar**. No server, no cost, and nobody else
can see your data.

## What you need
- A personal Google account (school and work accounts often block scripts)
- A free Gemini API key
- An iPhone with the Shortcuts app
- A computer for the one-time setup, about 15 minutes

## Setup

### Part 1: On a computer

**1. Get a free Gemini key.** Go to [aistudio.google.com](https://aistudio.google.com),
click **Create API key**, and create one. Keep it private.

<img width="600" alt="The API Keys page in Google AI Studio with the Create API key button highlighted" src="https://github.com/user-attachments/assets/236466fd-8c24-4806-98c8-3822c41336ce" />

**2. Copy the template.** Open [https://docs.google.com/spreadsheets/d/1MNyX8HtxjJQYHt-WO3JmCR_uURQT24z_mPnWFgtV9oU/copy] and click **Make a copy**. You’ll see a notice that the Apps Script file is copied too. That’s expected. It’s the bot’s code, and you can click View Apps Script file to read it first.


**3. Run setup.** In your copy, refresh the page. A **CalBot** menu appears at the top.
Click **CalBot → 1. Run setup** and paste your Gemini key when asked.

<img width="600" alt="The CalBot menu in the Sheet showing Run setup and Email me my shortcut link" src="https://github.com/user-attachments/assets/d9536534-af5d-4ff7-b497-1741a0c5d562" />


Google will ask for permission. You'll see "Google hasn't verified this app." That's
expected, since the script is yours. Click **Advanced → Go to (project name) (unsafe) →
Allow**. If nothing happens afterward, run **1. Run setup** a second time.

![Unverified app warning](docs/images/05-unverified-warning.png)

**4. Publish it.** This creates the link your iPhone will send texts to.

1. In your copy, click **Extensions → Apps Script**.
2. Click the blue **Deploy** button (top right) → **New deployment**.
3. Click the gear ⚙️ next to "Select type" and choose **Web app**.
4. Set **Execute as** to **Me**.
5. Set **Who has access** to **Anyone**. Don't pick "Anyone with Google account," because your
   iPhone can't sign in and the shortcut would fail. Your link is protected by a secret key that
   only you have. (On a school or work account this option may be greyed out, so use a personal
   Gmail.)
6. Click **Deploy**. If Google asks you to authorize access, click through the same
   **Advanced → Go to (project name) (unsafe) → Allow** screens as before.
7. Copy the **Web app URL**. It ends in `/exec`. Don't copy the **Deployment ID**, which is a
   different string. You can find the URL again anytime under **Deploy → Manage deployments**.

<!-- TODO screenshot: docs/images/08-deploy-web-app.png -->
**5. Get your shortcut link.** Back in the Sheet, click **CalBot → 2. Email me my shortcut
link** and paste the URL. A link arrives in your email.

![Email link](docs/images/10-email-link.png)

### Part 2: On your iPhone

**6. Add the shortcut.** On your iPhone, open the email and copy the link. Then open
[SHORTCUT LINK], tap **Add Shortcut**, and paste the link when it asks.

![Add shortcut](docs/images/11-add-shortcut.png)

**7. Make the trigger.** Open **Shortcuts → Automation → + → Message**. Set **Message
Contains** to `cal:` and **Sender** to your own contact card. Tap **Next → Add Action → Run
Shortcut → CalBot**, with input set to **Shortcut Input**. Tap **Next**, choose **Run
Immediately**, and turn **Notify When Run** off.

![Automation setup](docs/images/12-automation-trigger.png)

**8. Test it.** Text yourself `cal: bio homework due friday`. In about 10 seconds, a banner
confirms it, and a new event appears on your **Deadlines** calendar.

![Test text and result](docs/images/15-test-text.png)

## Using it
Start any message to yourself with `cal:`.

- `cal: hydro HW due tuesday, all 3 parts, remind me 1 hour before`
- `cal: thermo exam thursday at 2pm`
- `cal: send an email to my TA about my grade` (no date, so it lands today at 8pm)
- `cal: done with hydro HW`
- `cal: wait, need to resubmit hydro HW` (reopens it)
- `cal: hydro HW moved to next thursday`
- `cal: chem lab cancelled`

**Good to know**
- "Thursday" means the soonest Thursday. "Next Thursday" means the one after.
- No time given means a due time of 11:59pm.
- Default reminders: 5 days, 2 days, and 1 day before. Ask for extras in the message.
- Anything due today or tomorrow that isn't done turns red.
- When it can't tell what you meant, it says "Event denied." Check the **Log** tab.
- If several items match "done with homework," it picks the soonest upcoming one.

| Color | Meaning |
|---|---|
| 🟥 Red | Exams, quizzes, labs, projects, office hours, or due very soon |
| 🟨 Yellow | Homework and required school events |
| 🟩 Green | Emails, errands, fun |
| 🟪 Purple | Jobs, internships, networking |
| 🟦 Blue | The bot wasn't sure what category this is |
| ⬜ Grey | Done or cancelled |

## Troubleshooting
- **Banner says "Not authorized":** the link in your shortcut is wrong. Re-run
  **CalBot → 2. Email me my shortcut link** and paste the new one.
- **"Sorry, the file you requested does not exist":** the link was cut off. It must start with
  `https://script.google.com/macros/s/` and end with `/exec?key=...`.
- **Nothing happens when you text yourself:** check that the automation's sender is your own
  contact card, and that it's set to Run Immediately.
- **Event is wrong or missing:** open the **Log** tab in your Sheet. Denied rows show why.
- **Error mentioning Gemini 404:** the model name changed. Find the current Flash model name
  in AI Studio and update `GEMINI_MODEL` at the top of the code.
- **After editing the code,** publish it: **Deploy → Manage deployments → ✏️ → New version →
  Deploy.** Don't create a new deployment, or your link changes.

![The Log tab](docs/images/17-log-tab.png)

## Privacy and safety
- Everything runs in your own Google account.
- **Your shortcut link is a password.** Anyone with it can add events to your calendar, so
  don't share it or post screenshots of it.
- Gemini's free tier may use what you send to improve Google's products, so keep private
  details out of your messages.

## Roadmap (v2)
Home-screen widget, voice shortcut, group-chat support, text replies, and an optional study
planner.

## License
[LICENSE TBD]
