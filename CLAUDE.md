# BPQ — CLAUDE.md

# Response footer (ENFORCED — every project, every machine)
Every response ends with: `E.XX.YZZ [YYYY-MM-DD] [commitHash]`
- **E.XX** = exchange count this session, zero-padded (one user message = one exchange).
- **Y** = phase: `P` = Planning (nothing pushed), `B` = Built (committed AND pushed); local commits without a push stay `P`. **ZZ** = how many times that phase occurred this session; P and B counters are independent.
- **commitHash** = 7-char hash of the pushed commit; omit when nothing was pushed. Last line of the response, no exceptions.
