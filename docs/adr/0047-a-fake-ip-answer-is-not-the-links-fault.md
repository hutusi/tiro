# ADR 0047: A fake-ip answer is not the link's fault

Status: accepted (2026-10). Amends ADR 0034 §3's settled refusals, as
`refusal.ts` states them, and the ADR 0046 consequence that a fake-ip resolver
refuses a saved link and a web PDF for good. Changes nothing in the document
format, so `tiro.schema` is unchanged.

## Context

The processor resolves every host it fetches from and refuses one that
resolves to a non-public address, so a clipped page cannot aim it at loopback,
a private network or a cloud metadata endpoint. ADR 0034 made the refusal
settled: where a name points does not change by asking again, so the article
is marked `tiro.fetch_failed` and no run asks again.

That holds for the name's own records. It does not hold when the answer comes
from the machine's resolver instead. A proxy in fake-ip mode (Clash, Surge,
sing-box and their kin) answers every name it routes with an address from
198.18.0.0/15, the benchmarking range, and routes the connection by name. Such
proxies are common in mainland China. The machine that processed the vault by
hand while its Actions runs were blocked for billing (from 2026-10-15) used
one, and the external host ADR 0046 chose is there too.

Behind such a resolver every saved link and every web PDF was settled at
once. On 2026-10-16 a run by hand settled `openreview-net-pdf-a4174092` this
way: a PDF that would never get its summary or translation, recovered only
because the diff was read before the commit. The runbook told operators to
`git restore` any article settled this way before committing a run by hand. A
warning that every run by hand depends on is a defect in the code, not a
procedure.

## Decision

A resolved address in 198.18.0.0/15 is still refused, but it is not settled.
When every refused address a name resolved to is in that range, the guard
throws an ordinary error naming the address and the cause ("a fake-ip proxy's
address: this machine's DNS answers for its proxy"). The pipeline then does
what it does with any failure that may pass. The article stays pending, the
run reports it and goes red, and the next run on a machine with real DNS
fetches it.

- **Only as an answer.** A URL that names such an address itself is refused
  before anything is resolved, and settled as before: that is the link's
  property.
- **Only when every refused address is fake-ip.** A name that also resolves
  to a real private address is settled as before. A private record is the
  name's own.
- **Nothing is fetched either way.** The guard cannot see past the proxy to
  the real address, so this changes how a refusal is recorded, not what is
  refused.
- **Images are unchanged.** A refused image was never settled: it stays a
  hotlink, and a forced run on a clean host downloads it.

## Rejected

- **Allowing the range behind a proxy.** The guard would have to trust that
  the proxy resolves the name honestly and does not route to a private
  address itself, which it cannot check. It could be done as an opt-in that
  hands resolution to the proxy (`HTTPS_PROXY`), but that is a security
  decision of its own, and ADR 0046 deferred it.
- **Settling, with a louder warning.** The article is still lost to whichever
  machine ran the processor, and the warning is only as good as the operator
  who reads it.
- **Treating every resolved private address as retryable.** A name whose own
  records point inside a private network does not change by waiting. That
  would bring back what ADR 0034 settled for: a red run every day, forever,
  for an article nobody can fix by waiting.

## Consequences

- Behind a fake-ip resolver, saved links and web PDFs wait instead of being
  lost. Every run there goes red and names the cause, until the host gets
  clean DNS or the run moves to a machine that has it.
- A run by hand on such a machine no longer needs its diff checked for
  settled articles.
- A fake-ip proxy configured with another range (some use `28.0.0.0/8` or a
  private one) is not recognized, and settles as before. The guard knows only
  the conventional range, the one the owner's proxy uses.
