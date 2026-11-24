# Your account

Open your account page from the avatar menu at the top right of any page. Its
sections are Profile, Security, Connected apps, Assistant, Display, Editor,
Notifications, and Page setup, plus Invites once an admin has given you invites.
Connected apps is missing when the person who runs your Codex has turned it off. Changes save on their own:
a choice saves as soon as you make it, and a text field saves when you leave it.
A "Saved." note confirms each save.

On a large window, the sidebar lists the parts of Security and Assistant under
"On this page". Pick one to jump to it.

## Profile

Set your display name and, if you like, a separate pen name to show on your
public pages. If you write in a language that is not the one you grew up
speaking, set "Native language" to the language you grew up speaking. For a story whose language is set to
another language, the Assistant then also looks for habits carried over from
your native language, such as idioms translated word for word, false friends,
or prepositions and word order from it. It does this when a review checks
"Spelling and grammar" or "Prose and style", or has "Look for habits that
repeat in the prose" ticked, but not otherwise in a review with only "General
notes" or "Entities and lore". Leave it on "Not
set" to skip this. The public-page block is where you claim a handle: a short name
that becomes your public address at `/@yourhandle`. You can claim a handle once,
so pick it with care. Add a short bio and, if you take requests, a note that
your commissions are open with the details. Turn on the public profile toggle to
show this page to visitors; leave it off to keep it hidden. Either way, "Open
your page" next to the page address shows you the page as visitors would see
it; while it is hidden, a note on top says only you can see it.

You can upload an avatar when image storage is set up on the instance. Without
it, your initials stand in.

## Invites

When an admin has given your account invites, an Invites section appears in
the sidebar. Select "Generate an invite" to make a code, then "Copy link" to
get a sign-up link to send your friend. Each code admits one person, who can
sign in as soon as their email is confirmed. Revoke a code that has not been
used to take it back; that frees the invite so you can generate another.

The public page and avatar only appear to visitors once an admin has enabled
publishing for your account and your profile is set to public.

## Assistant

The Assistant is an optional writing helper that connects to a language-model
endpoint you choose and control. It is off until you turn it on, and it never
contacts a model on its own.

- **Kill switch**: the switch at the top turns the whole Assistant on or off. While
  it shows "Assistant off", nothing you write is ever sent to a model. Turn it off
  to use the Assistant; turn it back on to stop everything at once. The settings
  below are dimmed while the Assistant is off.
- **Identity**: give the Assistant a name and pick a style for how it writes back.
  The name shows wherever the Assistant appears.
- **Endpoint**: pick a provider from the list and paste an API key from that
  provider's website; the link under the picker takes you to the right page to
  create one. The base URL fills in by itself for these. Leave the key blank to
  keep the one already saved. Changing the provider clears the saved key, the
  models picked for each role, and any extra request settings, and asks first
  when there is something to clear. Paste the new provider's key, then select
  Discover models and pick again. Moving a custom endpoint to a different
  server clears its key too. Select Test connection to send a short message
  and see the model reply; it saves what you typed first, and tests with the
  Rubber duck model.
  - **Claude (Anthropic)**: create a key in the Anthropic console. A Claude.ai
    subscription (Pro or Max) is not an API key; API use is billed separately
    through the console, where you add credit first.
  - **ChatGPT (OpenAI)**: create a key on the OpenAI platform under API keys.
    Add billing details or credit there before the key will answer.
  - **Gemini (Google)**: create a key in Google AI Studio with a Google
    account. A free tier is available, with stricter rate limits.
  - **DeepSeek**: create a key on the DeepSeek platform under API keys and top
    up credit there.
  - **OpenRouter**: one key gives access to models from many makers, including
    all of the above. Create a key on openrouter.ai and add credit; this is the
    easiest way to try different models without holding several accounts.
  - **Custom endpoint**: enter the base URL of any OpenAI-compatible endpoint
    yourself, such as a local Ollama server (for example
    `http://localhost:11434/v1`). Local endpoints usually need no key, and your
    text never leaves your machine.
- **Tools offered**: while it works, the Assistant can read scenes from your
  stories and hand back suggested edits and comments. Leave this on All tools for
  a large hosted model. Pick Fewer tools if your model is small or runs on your
  own machine: it is then offered only the three it needs most (read a scene,
  suggest an edit, leave a comment), and it stops sooner instead of retrying,
  which smaller models handle far more reliably.
- **Lookups per reply**: how many times the Assistant may look something up
  in your work (read a scene, check a character, run a search) before it has
  to answer. The default is 20. A question about a whole chapter needs one
  lookup per scene, so raise it if replies say they ran out of lookups. Lower
  it if your endpoint charges per request. It also applies to reviews. With
  Fewer tools picked, the Assistant gets half this number.
- **Spend cap per background run**: the most one background review, summary
  update, pass suggesting details for the entries, or character arc may spend. Before
  each request to the model it works out what that request could cost with its
  reply at the longest allowed, and stops without sending it if that could take
  the run over the cap. It tells you how far it got and what it spent. If it
  stopped before it spent anything, or at a request that could cost more than
  the whole cap, raise the cap and then run it again: running it again as it is
  stops at the same place. A stopped summary update picks up where it left off when you run it
  again. To carry on with a review, either raise the cap and run it again, or run the same review again as it is: a run over the same
  scope (the same chapter, or the same whole story) skips the scenes the stopped
  run already read and starts from a fresh budget. Leave the box empty for no cap.
  This needs a price for the model, either one your endpoint publishes or one
  you typed in (see Prices, below); without a price the
  run says the cap could not be applied rather than stopping or ignoring it.
  See Usage and cost, below, for how requests are counted.
- **Warn above**: before a chapter or whole-story review starts, the review window
  shows what it will send and, where a price is known, what that costs. Above this
  figure it asks you to confirm again. Leave the box empty for the default of
  2.00.
- **Models per role**: pick which model handles each kind of help. Select Discover
  models to fill the lists from your endpoint, then choose one per role. The roles
  are Rubber duck (the side panel), Co-author (passages you can insert),
  Continuation (inline suggestions), Reviewer (suggested edits on a draft), and
  Background work (scene and chapter summaries, suggested entity details, the
  story recap, and the summary of a long conversation). Under each role's name is a suggested model for the provider you
  picked; see the list below. Roles with no model chosen fall back to the model
  you picked for Rubber duck. With Claude, a role uses its suggested model when
  neither it nor Rubber duck has one picked, so Test connection works as soon as
  the key is in. A universe or a story can choose its own models; see "Models for one universe or story" below. When the list is long, type part of a name in the filter box
  to narrow it; models you already picked always stay listed. If your endpoint
  publishes prices (OpenRouter does), each model shows what it costs per million
  tokens sent and received. Next to each role, Tune opens a window holding the
  rest of that role's settings, with the line beside the button saying what is
  set. The window saves when you close it.
- **Prices**: each model a role runs on gets two price boxes under
  the role list, next to its context window: dollars per million tokens sent
  (in) and received (out). Most providers, Claude and ChatGPT among them, do
  not report prices to Codex, so look them up on your provider's pricing page
  and type both in. Cost estimates, the review estimate, and the spend cap all
  need them. What you type is kept when you discover models again and is used
  instead of a price the endpoint reports. Leave both boxes empty to go back
  to what the endpoint reports. Check the boxes again when your provider
  changes its prices. If you fill only one of a model's two boxes, the rest of
  the form still saves and a message asks you to finish that price or empty
  both boxes. If you switch provider, or move a custom endpoint to another
  server, the prices you typed are cleared, so enter them again.
- **Keep repeated text ready for** (Claude only): Claude charges much less for
  text it was sent a short while ago, such as your story notes going out again
  with each message. Normally it remembers that text for 5 minutes. Choose 1
  hour if you often pause longer than that between messages. With 1 hour, new
  text costs about twice the normal price the first time it is sent.
- **Context window**: how much text a model can take in one request, counted in
  tokens. Each model a role runs on gets a box under the role list.
  Discover models fills the number in when your endpoint reports one, and the
  number shows next to the model in the lists. Type your own number to override
  it; what you type is kept the next time you discover models. Empty the box to
  go back to the reported value. If you run the model yourself, enter the size
  you started the server with (llama.cpp calls this the context size), not the
  largest the model could handle: that setting is what actually applies.
  The window also sets how much the Assistant reads on each request: a bigger
  window lets Rubber duck keep more of your conversation, and lets Rubber duck
  and Co-author carry more of your world (characters, lore, notes) into each
  answer, up to a fixed limit that keeps the cost of a long conversation down.
  Without a number, they use a fixed default.
- **Thinking**: in a role's Tune window, a Thinking list with three settings. On asks the
  model to reason before it answers: noticeably better reviews and feedback, at
  the cost of more tokens and a slower reply. Off tells the endpoint to skip that
  step, which is what you want for Continuation, Co-author, and Background work,
  where waiting is worse than a slightly plainer answer. Default leaves your
  endpoint to do whatever it already does. On the Claude provider, Off does the
  same thing as Default: Claude models decide for themselves whether to think, so
  the setting only ever turns thinking on.
- **Temperature**: on any endpoint other than Claude, a role's Tune window has a
  temperature slider running from 0 to 2, with a box beside it for an exact
  figure. Lower keeps the model close to the most likely wording, which is what
  you want for the Reviewer (around 0.2) and for Background work, where the
  answer should stick to the text. Higher lets it wander, which can suit the
  Co-author. Tick "Use the endpoint default" to hand the setting back to your
  endpoint. The Claude API is driven by the thinking and effort settings instead,
  so no temperature slider shows there.
- **Longest reply**: the most a model may write in one go, counted in tokens, set
  in a role's Tune window with a slider and a box. Raise it for a role whose
  answers get cut off mid-sentence, or lower it to keep a model brief. The slider
  stops at the model's context window where that is known. Tick "Use the Codex
  default" to go back to the length Codex asks for, which suits most setups.
  Thinking counts toward this length, so the default is much larger for a role
  that may think: any role on the Claude provider, or one with Thinking on or
  an effort set. When Background work may think, its short tasks (summaries,
  character arcs, suggested details) also get the full default, so they can use
  more tokens. Set its Longest reply yourself to keep them smaller. If a review
  fails because a reply was cut off, raise the Reviewer's Longest reply or lower
  its effort. If a character arc or a pass of suggested details fails the same
  way, do the same for Background work.
- **Let the assistant search the web (Claude only)**: off unless you turn it on.
  With it on, Claude may look things up when it reviews your work or answers you
  in the side panel, and only in a universe you have marked as an established
  setting, where checking your draft against a published world's canon is the
  point. Inline suggestions, drafting, and background work never search. The search runs on Anthropic's servers,
  not yours, and the results come back as part of Claude's answer; Codex itself
  still only ever talks to the endpoint you configured. Anthropic bills you for
  the searches. See [writing in an established setting](/docs/established-settings)
  for what this helps with and what it does not.
- **Extra request settings**: some endpoints take settings Codex has no box for,
  and each server spells them its own way. The box under Endpoint holds JSON that
  is sent with every request, for example `{"top_p": 0.9}`. Each role's Tune
  window has a box of its own too, laid over the endpoint one, for when a single
  role needs something different, such as a switch that turns reasoning off for
  the Reviewer. Check
  your server's documentation for what it accepts, and leave both empty if you are
  not sure: nothing here is needed for a normal setup. Test connection sends what
  a Rubber duck request would send, so it checks the endpoint settings and that
  role's own together. Codex sets the model,
  messages, tools, reply length, and streaming itself, so those cannot be
  overridden. When a spend cap is set, background work and drafts also leave out
  any setting here that changes how long a reply can be or asks for several
  replies at once, so the cap holds. This does not show on the Claude provider, which is driven by the
  thinking and effort settings instead.
- **Effort (Claude only)**: with the Claude provider, a role's Tune window also
  has an effort list. Effort sets how hard the model works on each request, from low (fast and
  cheap) to max (thorough and expensive). Current Claude models always think a
  little, so effort is how you keep a role quick. Left on the Codex default,
  on a current Claude model, Continuation and Background work run at low, Rubber duck and Co-author at
  medium, and the Reviewer at high, which suits most writers. On older or
  unrecognised Claude models the list shows "Endpoint default" instead, and no
  effort is sent unless you pick one. Not every model
  accepts every level ("xhigh" needs a recent Opus model, and small models may
  reject effort entirely); if a request starts failing after a change here, clear
  the effort for that role.
- **Usage**: every request the Assistant sends to your endpoint is listed here
  with the token counts the endpoint reported, plus a 30-day total. When prices
  are known (see Prices, above), an estimated cost shows too. The list shows 50 requests at a time;
  use Older and Newer to page through the rest. Only counts are kept; the text
  itself is never stored in this log. See Usage and cost, below.

Your words are sent only to the endpoint you set here.

### Usage and cost

- **Estimated rows**: with the Claude provider, when a request fails, or you
  stop it, before the endpoint reports its token counts, Codex estimates them
  from what had arrived. The same happens when a web search's results are not
  included in the counts the endpoint reports. Those rows say "estimated", and
  the 30-day total says how many it includes. A request you stopped can cost more than its estimate.
  With other providers, a stopped or failed chat reply shows "token counts
  not reported", and a failed background request is not listed.
- **Spend cap**: a request that fails partway is counted from what had
  arrived, or at its reply limit if its thinking was not shown, and the run's
  notice marks the amount as estimated. If the endpoint leaves out the
  token counts for any request, that request cannot be priced, and the run says
  the cap could not be fully applied.
- **Cached context**: most providers cache repeated context (your world
  details, earlier turns) and bill it far cheaper on reuse. With the Claude
  provider, text sent for the first time is billed a little higher so it can
  be reused. The cost in the list and the spend cap count reused text at the
  rate the provider publishes: a tenth of the price on Claude, about a quarter on
  Gemini and DeepSeek, and half on ChatGPT. Some models charge less than that, so
  the cost shown can run a little above what you were charged. With OpenRouter,
  reused text is counted at the price OpenRouter lists for the model, when
  you use the prices it reports. With a custom endpoint, or a price you typed
  yourself on OpenRouter, reused text is counted at the full price, so the
  cost shown can run well above what you were charged, and a spend cap can
  stop well before the figure you set. First-time text is counted at Claude's
  higher rate. Requests made before
  Codex kept those counts are priced with every token sent at the plain price.
  Reused text in each request is counted at the rate of the provider it was
  sent to (requests made before Codex kept the provider use your current
  provider's rate). The price per model comes from your current price list, so
  after you switch provider, earlier requests may show no cost or a different
  one.
  The estimate shown before a review counts each scene's first read, and the
  passes over the whole story, at the higher first-time rate.
- **Web searches**: with the Claude provider, the list shows how many web
  searches a request ran. The search results count as tokens like the rest of
  the request, and the spend cap allows for the most a request's searches could
  add before it sends one. That allowance is several times the size of the
  request itself, so with a low cap a review can stop before it reads its
  first scene; raise the cap or turn web search off if that happens. The
  estimate shown before a review leaves searches out, and says so when web
  search is on. Claude also charges a fee for each search on top of tokens;
  that fee is not in the cost shown here or counted by the spend cap.

### Which model to pick for each role

The roles want different things, so a single model for all five is rarely the
best you can do. Continuation and Background work want speed above
all: Continuation runs while you type, and a suggestion that arrives after you
have written the next line is worthless, while Background work runs summaries,
entity details, and recaps in bulk. The Reviewer wants the strongest model you
can run, since it reads a whole draft and has to be right about what it quotes.
Rubber duck and Co-author sit in between: pick a model whose writing you enjoy.

What that means on each provider, for the fast roles, the in-between roles, and
the Reviewer in that order:

- **Claude**: Claude Haiku 5.5, Claude Sonnet 5.5, Claude Opus 5.5.
- **ChatGPT, Gemini, DeepSeek, and OpenRouter**: a small, fast, low-cost
  model for the fast roles (names often include mini, lite, or flash), a
  mid-sized general model that writes well for the in-between roles, and the
  most capable model you can afford for the Reviewer.
- **Your own machine**: Qwen3 30B A3B (a mixture-of-experts model) for the fast
  and in-between roles, and Qwen3 32B (a dense model) for the Reviewer.

Providers other than Claude rename their models often, so select Discover
models and pick the newest one of the kind described.

Turn thinking off for Continuation and Background work. For the Reviewer, set a
low temperature so it quotes your text faithfully instead of paraphrasing it;
thinking is worth turning on if you can afford the wait. On Claude, the Codex
default effort already does this for you, so there is nothing to change.

On your own machine, search for "MoE instruct GGUF" to find mixture-of-experts
models. They hold many parameters but use only a small slice of them per word,
so they answer far faster than their size suggests, as long as they fit in
memory. A dense model (search for "32B instruct GGUF") uses every parameter for
every word: slower than a mixture-of-experts model of the same size, but
steadier at close reading.

### Models for one universe or story

A universe or a story can use different models from your account. For example,
you can give one long story a model that takes more text at once.

1. Open the universe's settings, or the story's settings, and select
   "Assistant". The section shows once the Assistant is set up on your account
   page.
2. For each kind of work, choose a model, or leave the row on "Default". A
   "Default" row names the model it will use.
3. Your choice saves as soon as you make it.

The most specific choice is used: the story's, then the universe's, then your
account's. Work that covers a whole universe, such as a universe chat, `/enrich`
or a character arc, uses the universe's models. To go back, set the row to
"Default" again.

The other settings for a kind of work (reply length, temperature, thinking),
prices and context windows stay the ones on this page. A model you choose for a
universe or story gets its own "Context window" and "Prices" boxes above, so you
can fill them in when your endpoint does not report them. If you switch provider,
the choices on your universes and stories are cleared along with your account's,
since they name the old provider's models.

## Display

Choose a light, warm, or dark theme, or follow your system, and pick an accent
colour from the swatches or a custom one. The warm theme is a softer, sunlit
version of the light one. When you follow your system, two extra choices let you
set which theme is used while your system is light and which is used while it is
dark. The change applies across the app right away.

Buttons and links use a darker shade of your accent so they stay readable. If
you pick a custom colour that is too light or too dark to read in some themes,
a note under the swatches says so and suggests a darker or lighter one.

To switch the theme without leaving the page you are on, open your account menu
(your initials in the top right corner) and pick Light, Warm, Dark, or System.

Under Library, choose how the library page shows your stories: Covers shows each
story as a book cover, No covers shows the same cards without the cover, and
Table lists your stories in rows with their status, word count, chapters, and
when you last changed anything in them. The switch above the stories on the library page
changes the same setting.

## Editor

How the writing area works, as your personal defaults.

- **Writing appearance**: the font and line spacing of the writing area. Choose
  Custom for the font and type the name of a font installed on your device; if it
  is not found, the default writing font is used. Choose Custom for line spacing
  to set the line height in centimetres. This is separate from Page setup, so you
  can write in one font on screen and export in another.
- **Editor behaviour**: turn entity autocomplete on or off, show or hide the
  scene marks in the continuous view, show or hide the writing streak, and set
  spell-check and its language. A story or universe with a language set in its
  details uses that language instead. There is also a choice between the
  markdown editor and the softer rich editing surface.
- **Daily word goal**: a daily word target. A universe's Insights page shows how
  close you are to it. Leave it blank for no goal.

## Notifications

What reaches you, and where: the bell in the top bar, email, both, or neither,
for each kind of event. Emails arrive batched, so a busy hour sends one message.

## Connected apps

An AI app you already use can read your writing in Codex and leave suggestions
for you. It can never change, delete or publish your text. Nothing can connect
until you turn this on. For a walk through connecting an app for the first
time, and what to do when it does not work, see
[Connecting an app](/docs/connecting-apps).

To connect an app:

1. Open Connected apps. Under "Allow other apps to connect", type your
   password, and the code from your authenticator app if you use two-factor
   authentication, then select "Turn on access for apps".
2. Copy the address shown under "Address to give the app".
3. In the app, add a custom connector (some apps call it a remote MCP server)
   and paste the address.
4. The app opens a Codex page. Sign in if asked, check the name and the web
   address of the app, choose what it may do, and select Allow. Select "Do not
   allow" if you did not start this yourself.

What you can allow:

- **Read your writing**: your universes, stories, scenes and entries. This is
  always included. A story where you have turned the Assistant off stays hidden
  from apps too.
- **Leave suggestions and comments**: suggested edits and comments that wait for
  you in Review, where you accept or reject each one. The app can also suggest
  a character, place or lore entry your universe does not have yet, propose
  splitting a scene in two, and hand you a draft it wrote for a scene. None of
  these changes your writing until you say so.

Where to find what an app left:

- Suggested edits and comments are in the story's Review.
- Suggested entries and proposed scene splits are in the universe's settings,
  under Suggestions. Select Accept to add an entry or Dismiss to drop it, and
  "Split here" to split a scene or Dismiss to leave it whole. See
  [Planning your world](/docs/planning).
- A draft waits on its scene. Open the scene and select the Assistant tab on
  the right to read it, change it, and keep or discard it, the same way as a
  draft from the Assistant. The card says which app wrote it. A scene holds
  one waiting draft at a time, so an app cannot leave another until you have
  decided.

Suggested edits, suggested entries and proposed splits are not part of your
export. What you accepted or kept is, because it is then part of your writing.
Review comments are exported with the story they are on. Waiting drafts are in
the export of your whole account (see [Security](/docs/security)), but not in a
story's own export.

A connected app is also given ready-made prompts for the work the Assistant
does in Codex: review, copyedit, continuity review, pattern pass, write,
rewrite, draft, draft a chapter, catch me up, a character or place sheet, and
search. Where an app shows them depends on the app; look for a list of prompts
or commands from Codex, pick one, and fill in what it asks for. You can also
ask the app in your own words.

"Apps with access" lists every connected app with what it may do and when it
was last used. Select Disconnect to stop one at once. Turning off "Allow other
apps to connect" disconnects them all, and so does changing or resetting your
password. Turning it off does not ask for your password; turning it on again
does. To use an app again afterwards, connect it again.

### Personal access tokens

Most apps connect by opening a Codex page where you allow them. A script or
tool of your own that cannot open that page can use a personal access token
instead. A token works like a password for the address under "Address to give
the app", so treat it like one.

To make a token:

1. Open Connected apps and make sure "Allow other apps to connect" is on. If
   it is off, turn it on with your password as described above.
2. Under "Personal access tokens", type a name for the tool that will use it.
   Suggestions and comments left with the token are shown under this name.
3. Leave "Leave suggestions and comments" ticked if the tool should be able to
   leave them, or untick it to let the tool read only.
4. Choose how long the token lasts. It stops working after that, and you make
   a new one.
5. Type your password, and the code from your authenticator app if you use
   two-factor authentication, then select "Create token". Each code works
   once. If you have just used one to turn access on, wait for the app to show
   the next.
6. Copy the token and store it somewhere safe. It is shown once and cannot be
   shown again.

In your tool, give the address as the server and send the token as a bearer
token.

The list shows each token with what it may do, when it expires and when it was
last used. Select Revoke to stop one at once. If you lose a token or think
someone else has it, revoke it and make a new one. Turning off "Allow other
apps to connect" revokes every token, and so does changing or resetting your
password.

## Page setup

How print and PDF output is typeset: page size, margins, font, paragraph style,
line spacing, default text alignment, and scene-break text. For the font, choose
Custom and type the name of a font installed on the reading device; if it is not
found, the default font is used. For line spacing, choose Custom to set the line
height in centimetres. The default text alignment applies to paragraphs that do
not carry their own alignment marker, and also shows while you write.

These are your defaults. Any single story can set its own and fall back to these
with a "use my account setting" option.

## Limits on your account

The person who runs your Codex can set limits on how many universes and stories
your account can have, how much space your uploaded images can take, and how
large one image can be (never more than 10 MB). If you reach one, Codex tells
you which limit it is and does not make the new universe or story, restore it
from the trash, or store the image. To go past a limit,
ask the admin of your site to raise it.

Universes and stories in the trash do not count toward the limits, so moving
one to the trash makes room. Restoring it counts again. If restoring one would
take you past a limit, it stays in the trash and is still deleted for good when
its days run out, so move another one to the trash first or ask the admin to
raise the limit. Text never counts.

Before a picture uploads, Codex shrinks one wider or taller than 2560 pixels
to that size, so it takes less space. A picture over your per-image limit is
saved again at lower quality, and then at a smaller size, until it fits. A
PNG, such as a screenshot, stays a PNG unless a WebP copy would be much
smaller; other pictures are saved as WebP. Pictures that already fit, animated
pictures such as GIFs, and ones that come out no smaller upload as they are.
A picture that still does not fit is refused. This applies to pictures you upload: pictures in your text, covers,
avatars and badges. Pictures inside a story file you import are not shrunk, so
one over your per-image limit is skipped and the rest of the story imports.

Images count until they are deleted. Replacing your avatar, a badge or a
story's cover does not delete the old image straight away: it keeps counting
until nothing uses it and the daily check below deletes it. A saved draft or a
published edition that still shows the old image keeps it in use, so it keeps
counting for as long as that draft or edition does. You can still make the
swap when you are at your storage limit, so your usage can read above the
limit until the old image is deleted. The swap has to be a direct replace:
choose the new picture in place of the old one. Removing the old picture first
and then uploading a new one counts as a new upload, which has to fit under
the limit. Until the old image is deleted, it still counts, so a later upload
or swap goes through only if it fits under the limit with the old image
counted.

Images in your text, covers, avatars and badges are freed once nothing uses
them any more. Codex checks once a day. The first time it finds that no scene,
note, entry, profile, saved draft, published edition or saved version in a
history shows an image, it notes the date and keeps the image. If the image
is still unused 30 days later, it is deleted. If you use it again in the
meantime, even only for a moment before you take it out again, the countdown
is cancelled, and the 30 days start over the next time a daily check finds it
unused. An image is also always kept for 30 days after you add it, used or not. Taking an image
out of a scene usually does not free it, because the scene's history still
holds the older text with the image in it.

After you delete a story for good, the next daily check starts those 30 days
for the images only that story used, including its cover. An image another
story still shows is kept. Deleting a universe for good starts those 30 days at once for
every image in it. The daily check then deletes each one that is still unused
30 days later and was added more than 30 days ago. An image a story in another
universe still shows is kept. Moving a story or universe to the trash is not
enough; its images are kept until the trash is emptied.

## Getting your work out

The Security section has two ways to take your work with you. Export prepares a
single zip of everything you own: every universe, story, scene, entity, note,
and uploaded image, all as markdown. It is built in the background and appears
ready to download a moment later (a bell notification tells you when). Review
comments are in the zip. Suggested edits that are still waiting are not, nor
are suggested entries, proposed scene splits or drafts you have not kept. Delete
removes your account and everything in it. See
[keeping your account secure](/docs/security) for both.
