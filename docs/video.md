# Submission video: single-take run sheet

The submission video is recorded live inside the HackerSquad project form. The form captures the shared screen, the camera and the microphone in the browser. There is no upload and no editing, the limit is 5 minutes, and re-recording is allowed. After the recording stops, processing takes a few minutes before Submit unlocks.

So this is a run sheet for one continuous take, not a shot list. It follows HackerSquad's suggested order: the problem, the tech stack, then the live demo and the code. Target length is 3:30 to 4:00. The hard stop is 5:00.

## Who does what

- **Eddy** drives Claude Desktop as the customer. He presents the deck, types both requests, and does the problem, the tech stack, the time-saved numbers and the close.
- **Karthik** is the owner of "Eddy's Auto". The shop's line is his own phone: the Dial call rings it, he answers on speaker, and the room hears both sides. He speaks the owner's lines, replies "Y" to the second request when it arrives as a real iMessage on his phone, explains why the call works, and speaks in the "what is real, what is mocked" beat.
- The joke budget is one: "Our shop owner today is Karthik. Karthik is not a mechanic."

The phone sits on speaker beside the laptop mic, and the webcam is on the phone, so viewers see it ring and see the iMessage arrive. Nobody talks over the call.

## Run sheet

Times are cumulative targets and assume a 60-second call. Slide titles are the deck's; the numbers are from deck v2 and shift if slides are removed, so go by title. Our Dial number calls Karthik's real phone, and the second request is a real iMessage to it (the fallback is under "Variants" below). Every owner line on the call is spoken by Karthik, in the words below.

| Time | Beat | On screen | Who speaks | The exact line |
| --- | --- | --- | --- | --- |
| 0:00 | Hook | Deck: Title (1) | Eddy | "Your agent can book a flight. It can't book Main Street. Personal agents now try to phone businesses." |
| 0:07 | The problem | Deck: Problem (2) | Eddy | "The new agent standards need a website, an API or an agent of your own. A three-person shop has none of those. The SBA counts more than 33 million small businesses in the US. Most will never build an API. All of them have a phone." |
| 0:26 | Tech stack | Deck: How it works (4) | Eddy | "Platypus is an MCP server, written in TypeScript with Hono and SQLite. An agent sends it a request. Platypus asks Darwin whether an agent already covers the job. If none does, Dial places one AI voice call, and the voice agent books through our tools during the call. Every step is an event in an append-only log, and a booking is confirmed only when the owner says yes." |
| 0:53 | The ask | Switch to the split screen: Claude Desktop on the left (fresh chat), the dashboard on the right. Eddy's card reads PHONE-ONLY | Eddy | "This is Claude Desktop with Platypus connected. I'm the customer." He types, while talking: "Oil change tomorrow afternoon, under $120, near 1025 Sansome." |
| 1:03 | Darwin | Dashboard: the Darwin panel with Darwin's result and the reason line | Eddy | "Platypus asks Darwin Search first. Darwin found no agent that can book it, so we go to the phone." |
| 1:12 | The owner picks up | Dashboard: booking pending, route call. The call panel shows the shop line ringing; the webcam shows Karthik's phone ringing | Eddy, then Karthik | Eddy: "Our shop owner today is Karthik. Karthik is not a mechanic." Karthik answers on speaker on the second ring: "Eddy's Auto." |
| 1:20 | Disclosure | Dashboard: call panel, transcript turns appearing | Caller AI, then Karthik | Caller: "Hi, this is an AI assistant calling on behalf of a customer's agent through Platypus. Is this Eddy's Auto?" Owner: "It is." |
| 1:28 | Price and slot | Call panel tool timeline: `check_slot`, then `hold_slot` | Caller AI, then Karthik | Caller: "A customer needs an oil change tomorrow afternoon. Do you have an opening, and what's the price?" Owner: "Two o'clock works. Eighty-nine bucks." |
| 1:42 | Booking through the tools | Timeline: `create_booking`. The booking shows as confirmed, with the owner's quoted words and a short code | Caller AI, then Karthik | Caller: "Tomorrow at 2pm for eighty-nine dollars. I'll book that. Can I confirm it's a 2019 Civic?" Owner: "Yep, booked." |
| 1:52 | The consent ask | Call panel | Caller AI, then Karthik | Caller: "Last thing. Next time a customer's agent needs you, can I text you instead of calling? Just a yes or no." Owner: "Yeah, text me." |
| 2:04 | Consent stored | Timeline: `record_consent`, `set_text_number`. The consent shows with the quoted sentence. Eddy's card flips from PHONE-ONLY to TEXT-ENABLED | Caller AI, then Karthik | Caller: "Perfect. What's the best cell to text?" Owner: "This one." Caller: "Got it, this number. Thanks!" The call ends. |
| 2:12 | Why that worked | Dashboard: call panel with the transcript and the price | Karthik | "That's the only call Eddy's ever takes from an agent. After this, just texts." |
| 2:18 | Typed result | Claude Desktop: the typed booking (shop, time, price, short code) | Eddy | "And my agent got back a booking, not a transcript." Hold on the result for two seconds. The code differs on every run, so read it only if you read it off the screen. |
| 2:25 | Second request | Claude Desktop, then the webcam on Karthik's phone, where the iMessage arrives | Eddy, then Karthik | Do not type until the call panel shows Call ended. Then Eddy types "Also book a brake inspection there next week." and says: "Second request. No call this time." The iMessage lands on Karthik's phone. Karthik reads it aloud as it arrives, then replies: "Y". |
| 2:49 | Confirmed | Dashboard: the booking confirmed from the owner's text. Claude Desktop: the second typed booking | Eddy | "No call. A text, and one letter. A booking is confirmed when the owner says yes, never because the AI said so." |
| 2:58 | Time saved | Deck: Time saved (6) | Eddy | "Time saved, as estimates. Today a customer calls about three shops: fifteen to twenty-five minutes per booking. With Platypus it is one sentence and a typed result, under a minute with review and corrections. The owner spends about seventy-five seconds once, then five to ten seconds per job by text, not a three-to-five-minute call. We measure opt-in rate and reply seconds live." |
| 3:24 | What is real, what is mocked | Browser: the repository README at "What is real today and what is mocked" | Karthik | "What is real: a live Dial AI call to a real phone, booking through our tools mid-call, consent stored with the owner's exact words, a live Darwin search, a real iMessage and a real Y. What is mocked: Eddy's Auto is not a business, it is my phone, and I am not a mechanic. The other five shops are fictional. SMS to arbitrary regular numbers still needs 10DLC; iMessage is approved. And the time-saved baseline is an estimate, next to cited figures." |
| 3:51 | Close | Deck: Close (8), with the repository, the demo link and both names | Eddy | "Businesses live on the phone. Agents live online. Platypus lives in both. Next, ten real shop owners. We're Eddy and Karthik, and the code is on GitHub." Stop talking, count two seconds, stop the recording. |

The sheet ends at about 4:02. Checkpoints: the shop line is ringing by 1:15, consent is stored by 2:15, and the second booking is confirmed by 3:00. If the take is running long, shorten the tech-stack sentence about TypeScript and the last sentence of the time-saved beat. Do not rush the call.

### Variants

Say only what the screen shows.

- **Fallback: Dial-to-Dial.** If the real-number path fails on the day, both ends are Dial numbers: the call goes from our Dial number to a second Dial number that stands in for Eddy's Auto's line and is answered by Dial's inbound AI playing the owner (its short instruction is set by `pnpm dial:owner-sim`; `--show` prints it), texts use `TEXT_CHANNEL=dial` with `DIAL_OWNER_LINE`, and Karthik replies from the dashboard's owner-phone panel (`POST /demo/owner-reply`), which only ever replies to our own number. The joke becomes "Our shop owner today is an AI. It is not a mechanic." Say on screen that both ends are Dial numbers; never say a phone rang or received a text.
- **Darwin.** Say "Darwin found no agent that can book it": true for both answers Darwin gives us (`no_match` with the application key, or listed agents none ready). Run `pnpm --filter @platypus/gateway demo:cli warm` right before the take so the answer is cached.
- **Anything on a fake.** If any piece ran on its fake (`DIAL_IMPL=fake`, `GATEWAY_IMPL=fake`), the real-and-mocked line names it, and the take does not call it live.
- **The call script.** The caller AI's lines above are the call script in `packages/voice`. If that script changes, copy the change here before recording. In the fallback, the script closes by addressing the owner by the name the owner gives at pickup, so the owner instruction and the closing line must use the same name (Eddy in `scripts/owner-sim.ts`, "Thanks, Eddy").

## Before each take

Screen and sound

- [ ] In the HackerSquad project form, start the recorder, share the **entire screen** (not a window or a tab), and allow the camera and the microphone.
- [ ] The webcam preview shows Karthik's phone, screen up and in focus, so viewers see the call and the iMessage arrive. The mic meter moves when the phone speaks.
- [ ] Do Not Disturb is on, on the laptop. Quit Slack, Mail and Messages: an iMessage notification would show up on the shared screen.
- [ ] Three views are ready to switch between: the deck on its Title slide, the split screen (Claude Desktop with a fresh chat and large text on the left, the dashboard on the right with the Darwin and call panels visible without scrolling), and the GitHub README open at "What is real today and what is mocked".
- [ ] The Close slide has both names, the repository link and the demo link filled in.
- [ ] A QuickTime screen recording, with the microphone, is running before the form recorder starts. It is a local backup only. HackerSquad has no upload, so it cannot replace the in-form recording.

The shop line

- [ ] Eddy's Auto's line is Karthik's phone, the first number in `ALLOWED_NUMBERS`. It is charged, on speaker beside the laptop mic, with the volume up, Do Not Disturb off and every notification off except Messages.
- [ ] Eddy's phone is on silent, with every notification off.
- [ ] Karthik says only the owner's lines: "Eddy's Auto." / "It is." / "Two o'clock works. Eighty-nine bucks." / "Yep, booked." / "Yeah, text me." / "This one." After the call ends he explains why it worked.
- [ ] Eddy does not type the second request until the call panel shows Call ended.

Network and services

- [ ] The phone hotspot is on and tested as a backup network. If the Wi-Fi drops, switch before a take, not during one.
- [ ] `pnpm run doctor` is clean and `PUBLIC_BASE_URL` answers.
- [ ] `.env` has `DEMO_MODE=live`, `DIAL_IMPL=real`, `GATEWAY_IMPL=real`, `TEXT_CHANNEL=imessage`, `DIAL_NUMBER` and `DIAL_FROM_NUMBER_ID` set, `ALLOWED_NUMBERS` starting with Karthik's phone, and `DARWIN_ENABLED=true` unless Darwin was cut.
- [ ] `pnpm live:reset` has run (plain `pnpm demo:reset` resets only the fakes database while `.env` says `DEMO_MODE=fakes`), `pnpm live` is running, and Eddy's card reads PHONE-ONLY with an empty event log. Stop `pnpm live`, run `pnpm live:reset` and start it again before every take.
- [ ] Claude Desktop is connected through `npx -y mcp-remote http://localhost:8787/mcp` and lists the Platypus tools.
- [ ] No terminal and no code editor on screen. The repository is shown through the README.

Timing: record at 4:00 PDT and submit by 4:30 PDT. A take costs about six minutes with the reset, and processing takes a few more before Submit unlocks, so start the last take by 4:15.

## If something breaks mid-take

The rule is to stop and re-record from the top. Never cut inside the call, and never narrate around a failure as if it worked. Say what is on screen.

- **Karthik's phone does not ring within 15 seconds of the request.** Stop the take. If a call is live, hit the kill switch first. Check `pnpm run doctor`, run `pnpm live:reset`, and record again. If the real-number path still will not connect, use the fallback under "Variants" and say so on screen.
- **The call connects but the audio is bad.** Stop and re-record. The transcript on the dashboard is not a substitute for a take with clear audio. Check that the phone is on speaker beside the laptop mic.
- **The mid-call tools do not fire.** Stop and re-record. A booking that was made by the call but not through the tools cannot be confirmed from the transcript, by design, and the video must not claim it.
- **Darwin is slow or errors.** Keep going if the dashboard shows the failure and the booking still routes to the call. Say what the panel shows (see "Variants"). Do not wait on it more than 15 seconds.
- **The iMessage does not reach Karthik's phone within 10 seconds.** Resend once from the dashboard. If it has not arrived after 20 seconds, stop and re-record.
- **Claude Desktop hangs, or the network drops.** Stop. Restart Claude Desktop or switch to the hotspot, run `pnpm live:reset`, and record again.
- **The consent exchange goes off script (the caller's question, or Karthik's answer).** Re-record. It is the one moment the whole take depends on.
- **The take runs long.** A clean take that ends between 4:00 and 5:00 is still valid. If it is on pace to pass 5:00, the recorder will cut it off, so stop and re-record with the trims named under the run sheet.
