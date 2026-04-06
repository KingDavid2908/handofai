export const MEMORY_REVIEW_PROMPT = `Review the conversation above and consider saving to memory if appropriate.

Focus on:
1. Has the user revealed things about themselves — their persona, desires,
   preferences, or personal details worth remembering?
2. Has the user expressed expectations about how you should behave, their work
   style, or ways they want you to operate?
3. Did the user correct or reject a tool usage? Capture their preferences and
   the corrected approach.

If something stands out, save it using the memory tool.
If nothing is worth saving, do not call any tools. Just stop.`

export const SKILL_REVIEW_PROMPT = `Review the conversation above and consider saving or updating a skill if appropriate.

Focus on: was a non-trivial approach used to complete a task that required trial
and error, or changing course due to experiential findings along the way, or did
the user expect or desire a different method or outcome? Did the user correct how
a tool was used or reject an approach — capture the corrected method.

If a relevant skill already exists, update it with what you learned.
Otherwise, create a new skill if the approach is reusable.
If nothing is worth saving, do not call any tools. Just stop.`

export const COMBINED_REVIEW_PROMPT = `Review the conversation above and consider three things:

**Memory**: Has the user revealed things about themselves — their persona,
desires, preferences, or personal details? Has the user expressed expectations
about how you should behave, their work style, or ways they want you to operate?
Did the user correct or reject a tool usage? If so, save using the memory tool.

**Skills**: Was a non-trivial approach used to complete a task that required trial
and error, or changing course due to experiential findings along the way, or did
the user expect or desire a different method or outcome? Did the user correct how
a tool was used or reject an approach? If a relevant skill already exists, update
it. Otherwise, create a new one if the approach is reusable.

**Lessons**: Did the user correct your approach or reject a tool call?
Did something fail that you had to work around? Capture the mistake,
the correction, and the better approach using the lesson tool.

Only act if there's something genuinely worth saving.
If nothing stands out, do not call any tools. Just stop.`
