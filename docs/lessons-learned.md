# Human Learnings From Running Flagship

Short lessons about how humans actually stay sane while running a multi-machine AI fleet. *(Technical architecture decisions live separately in [ADR-append-log.txt](ADR-append-log.txt).)*

- **Keep your Home thread on the bridge, never in the engine room.** The moment your main chat starts reading big files or debugging builds, it becomes slow, noisy, and painful to use. Dispatch every real task out to a worker thread so **Helm** stays light enough to dump ideas into all day.
- **Quiet by default beats constant status chatter.** Only wake the operator when something finishes, stalls, or genuinely needs a human call. If nothing changed, say nothing.
- **Clear old failures aggressively.** Yesterday's abandoned experiments will bury today's real blockers. Dismiss stale `[FAILED]` alerts in one command (`helm dismiss --all-failed`) so "Needs Attention" actually means it.
- **Separate two-way doors from one-way doors.** Let workers ship easily revertible changes autonomously; stop and escalate to **Helm** only for hard-to-revert changes, explicit staging holds, or surprise scope growth.
- **Ground product decisions in real user counts, not effort or percentages.** Always ask *"how many real people hit this per week?"* and *"can a lightweight UX nudge beat building complex code?"*
- **Keep team-specific rules local.** Put repo names, QA holds, and internal analytics habits in `~/.flagship/policy.md` so the shared Flagship setup stays clean and portable.
- **Prefer short bulleted briefs over wide tables.** Wide markdown tables wrap badly on phones and narrow panes. Four short buckets (**Needs Your Decision** · **Shipped / Ready** · **In Flight** · **Captured Ideas**) with clickable links read much faster.
