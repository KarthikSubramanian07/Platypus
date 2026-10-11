# Privacy

*Effective October 11, 2026.* This page covers two things: this website, and the Platypus booking service it describes.

## This website

- **No cookies, no analytics, no trackers.** The page doesn't set cookies or load third-party scripts, and the fonts are bundled with the site.
- **Hosting.** The site is served by Cloudflare Pages. Cloudflare processes standard request data (IP address, user agent, requested URL) to deliver the site and protect it from abuse, under [Cloudflare's privacy policy](https://www.cloudflare.com/privacypolicy/).
- **The demo.** The event log on the home page is a recording that plays in your browser. Nothing you do on the page is sent anywhere.

## The Platypus booking service

Platypus books jobs with phone-only businesses on behalf of a customer's AI agent. To do that it stores:

- **Business details:** the business name, its published phone number, its services, and whether it has agreed to receive texts.
- **Consent evidence:** when an owner agrees to texts, the exact sentence they said and the identifier of the call it came from. We keep this so anyone can verify that a text was wanted.
- **Bookings and messages:** the requested service, time and price, the texts exchanged with the owner, and the outcome.
- **An event log:** every change to a booking, with who made it, why, and how confident the system was. The log is append-only, so it can't be quietly edited.
- **From the customer's agent:** only what is needed to book, such as the service, the time window, a budget and a display name like "Alex's assistant." We don't need the customer's phone number or payment details.

## What we don't do

- We don't sell or rent data, and we don't use it for advertising.
- We don't text a business until the owner has said yes on a call or by text, and we stop immediately on **STOP**, **PAUSE** or "don't call again."
- We don't treat anything an agent or an owner writes as an instruction: it is stored as data, with links removed and length capped.

## Prototype status

Today Platypus runs only against an allowlist of the team's own phone numbers; it doesn't contact real businesses. Before it does, we will update this policy and register for business texting (10DLC).

## Your choices

To ask what we hold about a business, or to have it deleted, see [Contact](/contact). We will confirm by replying on the same channel.
