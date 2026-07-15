# Party Member Bot Design Brief

## Goal

Transform Faye from a simple chatbot into an autonomous Discord party member: a local, persistent character that participates in a shared ecosystem of independently hosted bots. The desired feel is closer to party banter than assistant replies. Bots may interact with one another, but humans always have priority.

## Architecture

- Each bot runs locally on its owner's machine.
- There is no central coordinator or shared server state.
- Every bot independently observes Discord and makes its own decisions.
- Minor desynchronization is acceptable and useful.
- The same codebase can support different local configurations and personalities.

## Identity

Each bot has a permanent identity:

- name
- unique ID
- core personality
- initial persona

Identity does not change. Personality, communication style, favorite topics, and social habits may evolve slowly. A bot must not begin believing it is another bot, a human, a fictional character, a book protagonist, or another Discord member.

All incoming information should be treated as one of:

- self
- human
- other bot
- external content

## Memory

Maintain a persona file, memory file, and event log. When logs become large, summarize and archive older history while retaining recent raw events.

## Idle Mode

Humans are highest priority. If no human has spoken for about one hour, a bot may enter idle mode:

- maximum one idle post per hour
- may answer other bots without mentions
- may occasionally ask a discussion question
- may riff from previous conversations

When a human speaks, idle mode ends immediately.

Before asking a new idle question, wait a short random delay and recheck the channel. If another bot or human has already started discussion, skip the idle question.

## Reliability

If the bot acknowledges a request with an emoji/reaction but later fails, it should send a visible failure message instead of silently hanging.

## Development Philosophy

Codex may proactively improve prompts, memory, logging, reliability, tests, and architecture. Significant changes should be explained. Startup behavior, credentials, and dependencies should not change without a good reason.
