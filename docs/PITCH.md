# Present: live pitch

Stephen wears the headset, Matthew is the customer. The laptop mirrors Stephen's view (`scripts/cast-quest.sh`).

## 90 seconds

**[0:00, hook]**
Your AI shouldn't stop knowing you when you close your laptop. Today every agent only knows what you type into it. But the stuff that matters, a customer telling you what's broken, a promise you make across a table, happens away from the keyboard. So we spend our evenings turning our lives into prompts. Present makes that step disappear.

**[0:15, see + remember]**
Stephen is wearing a Quest 3S. Think of it as the dev kit for open smart glasses: cameras, mics, hands, passthrough. He looks at Matthew. Matthew opted in, so a local face model recognizes him, and GBrain puts up a card: who he is, when they last met, what Stephen owes him. As they talk, watch the card: a live pass is writing new facts into GBrain every twenty seconds.

**[0:35, act]**
Matthew asks for a `!recap` command in Opal's Discord bot. Nobody talks to the AI. Present pulls out a structured event, feature request, not a transcript, and fires a WorldHook in our QM fork. A swarm spins up next to Matthew: Context checks GBrain for who he is, Product writes the spec, Builder runs Claude Code and opens a real PR. Stephen approves it with a pinch.

**[0:60, learn]**
Memorable records what the swarm did as a procedure and we bridge it into GBrain. When the next customer asks for a similar command, the procedure is recalled from the real-world event, no prompt typed. Honest note: our measured runs don't show run 2 being cheaper yet. The HUD says "no gain" instead of faking it. The plumbing to learn from reality works; making it pay off is next.

**[1:20, close]**
GBrain gave agents memory. QM gave agents a workforce. Memorable lets that workforce learn from experience. We gave all three access to reality.

## 30 seconds

Your AI shouldn't stop knowing you when you close your laptop. Present is a reality layer: a Quest 3S, our smart-glasses dev kit, recognizes opted-in people, pulls feedback, commitments and requests out of real conversations as structured events, remembers them in GBrain, and fires a QM swarm that ends in a Claude Code PR while you're still talking. Memorable records how the swarm did it and recalls that on the next similar moment. GBrain gave agents memory, QM a workforce, Memorable experience. We gave them reality.

## Judge Q&A

**Why a VR headset?**
It's the dev kit, not the product. Quest 3S has what smart glasses will ship with (cameras, mics, head pose, hands, passthrough), and we can build against it today. The client is a WebXR page speaking a plain WebSocket contract, so the same pipeline moves to glasses unchanged.

**Privacy?**
Recognition only against a local, opted-in set: you enroll by introducing yourself ("I'm Matthew"), and a stranger saying an enrolled name can't hijack that identity. We store face embeddings, never photos. Frames and audio are processed in memory and dropped; GBrain gets summaries and signals, never transcripts. No internet lookup. One command removes a person. Agents draft outbound messages and wait for approval.

**How is this different from Granola / meeting notes?**
Notes are the output there; here they're the input. We ground in a person (face match, relationship history), emit typed events rather than a summary, and those events trigger agents that do the work: spec, code, PR. And it's out in the world, not only in scheduled calls.

**What did you add to QM?**
On our fork (`MatthewKim323/qm`, branch `worldhooks`): WorldHooks, a new `POST /world-events` trigger with per-type swarm plans; a swarm tracker that streams to the HUD and measures every run; WorldWatches you create by speaking ("next time Matthew brings up pricing, prep a counter-offer"); entity-bound agents you adopt with a pinch. And a fix: upstream's Memorable integration didn't record or recall for event-triggered turns, now it does.

**Is Memorable actually helping?**
Not measurably yet, and we won't claim it. Record and recall work end to end off real events. But on the Opal pair, run 2 went 40 -> 42 tool calls and 10 -> 13 turns; the best customer-feedback pair cut turns 9 -> 7 and wall time 285s -> 248s while tool calls rose 41 -> 50. Baseline runs alone vary 30-45 tool calls. The cost is swarm plumbing, which is what we'll target with recalled procedures next.

**What ships next?**
Recalled procedures that skip swarm plumbing, measured over enough runs to mean something. Pre-warmed sandboxes so the swarm finishes inside the conversation. Native Quest camera for aligned anchoring, then glasses. Whiteboard decisions and physical bugs as events (already in the contract).
