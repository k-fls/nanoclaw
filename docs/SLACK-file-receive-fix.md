One-line fix in src/channels/slack.ts line 80:

  Before: if (subtype && subtype !== 'bot_message') return;
  After: if (subtype && subtype !== 'bot_message' && subtype !== 'file_share') return;

  Slack file uploads arrive with subtype: 'file_share'. The old filter dropped all subtypes except bot_message, silently ignoring every
  file upload. The rest of the media handling code (lines 128-162) was already correct — it just never ran.
