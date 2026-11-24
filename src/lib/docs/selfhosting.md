# Running Codex yourself

Codex can run on a computer you look after, instead of on one somebody else looks after for you. That is what self-hosting means: the app runs on your own machine or your own server, and everything you write is stored there.

There are two ways to use Codex, and they are the same app.

- **Hosted.** Someone else runs Codex and you sign in to it. Nothing to install, nothing to keep up to date.
- **Self-hosted.** You run Codex yourself. Your writing lives on your machine, and nobody else has a copy unless you make one.

Every feature works the same either way: the same editor, the same planning tools, the same reading pages, the same exports. You can move your work between the two whenever you like, because everything you write leaves as markdown files and comes back in through the story import. See "Getting started" for where the export and import live.

## What it takes

Codex needs a machine that stays on when you want to use it, a Postgres database, and a web address if you want to reach it from anywhere but that machine. The steps and the commands live with the project's code, in its README, because they change as the app does. Follow those and you will have Codex running.

If none of that sounds like something you want to do, use a hosted Codex instead. Nothing in the app is held back for people who self-host, and nothing is held back for people who do not.

## Connecting AI apps

People with an account can connect an AI app they use, such as Claude, so it can read their writing and leave suggestions; see [Connecting an app](/docs/connecting-apps). Apps that run on the internet connect from their own servers, so they can only reach a Codex that has a public web address starting with `https://`. A Codex that only answers on your own computer or your home network cannot be reached by them. If you run Codex for others and do not want this at all, turn it off in the admin panel.

## Running it for other people

A Codex you run can hold accounts for other people, each with their own writing. Whoever runs it decides who gets in: nobody, invited people only, people who ask and get approved, or anybody who signs up. If you are the one running it, that setting is in the admin panel. The front page visitors see before signing in is short by default; to show the full introduction, set the type to Public service under Instance in the admin panel.

Nobody has limits unless you set them. To limit how many universes and stories an account can have, how much space its uploaded images take, or how large one image can be (never more than 10 MB), set the limits on a plan under Plans in the admin panel, then pick that plan for the account under Usage & storage. Usage & storage also shows what each account uses.

Images that nothing has used for 30 days, and that were uploaded more than 30 days ago, are deleted by a job that runs every night at 03:00 UTC. The file of a deleted image is kept for 30 more days, and each deletion is written to the server log as `assets.unused_deleted` with the image's details, so you can put an image back by hand during that time.
