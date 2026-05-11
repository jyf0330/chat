# Android Relationship Strategist v0.1 Design

## Product Positioning

Android-only relationship strategist for real chat moments.

The product is not an AI keyboard, not a full input method, and not an automatic chat reader. It is a floating Android assistant that helps the user understand a copied conversation, choose a relationship strategy, and produce a reply they can paste back into the chat.

One-line promise:

> Copy a chat, tap the floating strategist, understand the situation, and get the best next reply.

## Target User

The first version targets users who often hesitate before replying in emotionally sensitive or high-stakes conversations:

- dating and ambiguous relationships
- conflict repair
- keeping a relationship warm without pressure
- polite rejection and boundary setting
- customer or business relationship follow-up

v0.1 should feel like a calm communication coach, not a manipulative pickup tool or a bulk messaging assistant.

## Core User Flow

```text
User copies a chat message or short conversation
↓
Floating strategist is available on screen
↓
User taps the floating button
↓
App opens a half-screen strategy panel
↓
Panel reads the current clipboard after the tap
↓
User selects or confirms relationship object, stage, goal, and tone
↓
AI returns situation analysis, risk warning, best reply, alternatives, and next-step advice
↓
User taps a reply to copy it
↓
User returns to the chat box and pastes/sends manually
```

The product must preserve the user as the sender. It should never auto-send a message.

## P0 Scope

P0 proves one complete loop:

- Android app shell
- floating button permission and foreground service
- half-screen strategy panel
- manual clipboard read after user tap
- relationship object selection
- lightweight relationship profile
- relationship stage selection or AI suggestion
- goal and tone selection
- AI strategy generation
- five reply candidates
- copy selected reply to clipboard
- local history
- delete single history item and clear all history
- privacy onboarding

P0 does not include:

- iOS
- custom keyboard
- automatic message sending
- background chat reading
- Accessibility Service reading screen content
- screenshot OCR
- WeChat monitoring
- bulk messaging
- cloud-synced long-term memory
- paid subscription

## Core Experience

The half-screen panel should show four levels of help:

1. **Relationship stage**
   Example: ambiguous early stage, warming up, cooling down, repair, boundary setting, customer follow-up.

2. **Situation analysis**
   A short explanation of what the other person likely means and what the user should avoid.

3. **Best reply plus alternatives**
   One recommended reply and four strategic alternatives. Each reply must have a clear style label, not five near-duplicates.

4. **Next-step advice**
   A small suggestion about when and how to continue after this reply.

Example output:

```text
Stage: Ambiguous early stage
Goal: Keep connection without pressure

Situation:
The other person sounds tired, not necessarily rejecting you. Asking more questions now may create pressure.

Risk:
Do not ask "why are you tired again?" or push for a meeting now.

Best reply:
Then rest first, don't force yourself. We can talk when you feel better, I won't rush you.

Next step:
If they do not reply tonight, send a light check-in tomorrow around noon.
```

## Lightweight Relationship Profile

Each relationship object can have:

- display name or nickname
- relationship type
- current goal
- current stage
- observed style
- communication principles
- recent strategy notes

P0 should keep this lightweight. The user should be able to create or choose an object quickly from the panel. Detailed CRM-like relationship tracking is out of scope.

Suggested default relationship stages:

- new contact
- friend
- ambiguous early stage
- warming up
- cooling down
- repair after conflict
- boundary setting
- customer follow-up

Suggested goals:

- continue chatting
- warm up
- ask out
- reduce pressure
- repair conflict
- close a deal
- keep boundary

Suggested tones:

- natural
- warm
- playful
- direct
- high-EQ
- restrained
- business

## Android Architecture

Recommended v0.1 architecture:

- Kotlin Android app
- Jetpack Compose UI
- foreground service for floating button lifecycle
- overlay permission for floating button and panel
- Activity fallback for devices where overlay panel is unstable
- local storage with Room or DataStore
- HTTPS backend API for generation
- local-only history by default

Core modules:

- `FloatingAssistantService`: owns floating button display and state.
- `StrategyPanelActivity` or overlay panel controller: shows the half-screen UI.
- `ClipboardReader`: reads clipboard only after user action.
- `RelationshipRepository`: stores lightweight profiles and history locally.
- `StrategyApiClient`: calls backend generation API.
- `PromptContract`: defines structured request and response fields.
- `PrivacyGuard`: centralizes sensitive logging and data-retention rules.

## Backend API

P0 can use one endpoint:

```http
POST /v1/relationship-strategy
```

Request:

```json
{
  "conversationText": "最近真的有点累，改天再说吧。",
  "relationshipProfile": {
    "name": "小林",
    "type": "dating",
    "stage": "ambiguous_early",
    "goal": "keep_connection",
    "observedStyle": "slow replies, restrained expression"
  },
  "goal": "keep_connection",
  "tone": "warm",
  "language": "zh-CN",
  "count": 5,
  "requestId": "uuid"
}
```

Response:

```json
{
  "stageAssessment": "ambiguous_early",
  "situation": "The other person sounds tired, not necessarily rejecting the user.",
  "riskWarning": "Avoid chasing, questioning, or pressuring for a meeting.",
  "bestReply": {
    "label": "warm and low-pressure",
    "text": "那你先好好休息，别硬撑。等你缓过来我们再聊，我不催你。"
  },
  "alternatives": [
    {
      "label": "playful but safe",
      "text": "收到，那今天先放过你。记得早点休息，我晚点不吵你。"
    }
  ],
  "nextStep": "If they do not reply tonight, send a light check-in tomorrow around noon.",
  "safetyFlags": [],
  "requestId": "uuid"
}
```

## Implementation Difficulties

### Clipboard Reliability

Android restricts clipboard access for background apps. The app should not depend on passive background clipboard reading. The reliable P0 behavior is:

- user copies text
- user taps the floating button
- panel becomes foreground/visible
- app reads clipboard after the explicit tap

If clipboard read fails, show:

```text
没有读取到复制内容，请重新复制后再点一次。
```

### Floating Window Compatibility

The floating button requires overlay permission and may behave differently across Android vendors. P0 should include:

- clear permission onboarding
- persistent notification while the floating assistant is active
- fallback to opening a normal Activity panel
- device compatibility smoke tests on Pixel/emulator plus at least one Xiaomi/OPPO/vivo/Huawei device before release

### Privacy Trust

The app handles sensitive chat content. P0 must state:

- content is read only after the user taps the assistant
- content is sent to the server only when the user taps generate
- no automatic chat reading
- no automatic sending
- no Accessibility Service screen reading
- local history can be deleted
- production logs do not store raw chat text by default

### Strategy Quality

The model must not merely produce five rewritten replies. It must return structured strategy:

- stage assessment
- situation analysis
- risk warning
- best reply
- alternatives with distinct labels
- next step

Backend prompts and response validation should reject low-diversity or unstructured outputs.

## Option Analysis

### Option A: Floating Button + Half-Screen Panel

Recommended for v0.1.

Pros:

- best matches the desired user flow
- does not require replacing the keyboard
- feels like a chat companion beside any app
- user remains in control

Cons:

- overlay permission friction
- vendor compatibility work
- clipboard read cannot be passive or guaranteed in background

### Option B: AI Keyboard

Pros:

- stable text insertion through IME APIs
- clipboard access is more predictable when used as input method
- less overlay compatibility work

Cons:

- user must switch keyboard
- product feels like a tool, not a relationship strategist
- Android-only goal no longer needs cross-platform keyboard consistency

### Option C: Floating Button + AI Keyboard Fallback

Pros:

- strongest reliability if clipboard or paste flow fails
- can later support direct text insertion

Cons:

- more setup friction
- more engineering scope
- harder onboarding

### Option D: Accessibility-Based Auto Reading

Rejected for v0.1.

Pros:

- could read screen content more automatically

Cons:

- high privacy risk
- high review and platform risk
- easy to look like WeChat monitoring
- undermines trust

## Recommended v0.1 Decision

Build Option A:

```text
Android floating strategist + half-screen panel + explicit clipboard read + manual copy back
```

Keep AI keyboard and Accessibility Service out of P0.

## Error States

P0 must handle:

- overlay permission not granted
- foreground service killed
- clipboard empty
- clipboard content too short
- clipboard content too long
- network request fails
- model returns unsafe or unusable output
- user has no relationship profile yet
- history storage fails

Suggested content limits:

- too short: less than 4 Chinese characters or less than 2 words
- normal: recent 1-15 chat messages
- too long: truncate to the most recent useful segment and tell the user

## Testing and Verification

Manual acceptance tests:

- copy a message in WeChat, tap floating button, generate, copy reply, paste back
- same flow in SMS or another chat app
- deny overlay permission and verify onboarding
- kill/restart app and verify floating assistant recovery
- read empty clipboard and show error
- generate with short and long content
- delete one history item and clear all history
- verify no raw chat text appears in production logs

Quality acceptance tests:

- five replies have distinct strategic labels
- best reply matches the selected goal and tone
- situation analysis is concise and not overconfident
- risk warning is actionable
- next step is specific but not manipulative

## Open Risks

- Some Android vendors may aggressively kill the floating service.
- Clipboard read may still fail in specific app or OS combinations.
- Relationship strategy quality will depend heavily on prompt and model choice.
- Users may distrust overlay and clipboard permissions unless onboarding is unusually clear.

## Stop Condition for v0.1

v0.1 is complete when a user can:

1. enable the floating strategist,
2. copy a real chat message,
3. open the half-screen panel,
4. generate a relationship strategy,
5. copy one reply,
6. paste it back manually,
7. view and delete the local history record.
