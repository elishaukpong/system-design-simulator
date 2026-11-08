# System Design Simulator

Build a system out of components on an isometric 3D grid, turn up the traffic, and watch which part breaks first. Then add what stabilises it.

The point is pressure recognition, not technique memorisation: the simulator names the **binding pressure**, traces symptoms back to their root cause, and says what binds next.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # engine + diagnosis tests
npm run build
```

## Play it

A guided tour starts on the first visit, and the **?** next to the logo brings it back. Entering a scenario for the first time adds a short tour of how tests work.

1. Load a template (or start blank), or pick components from the left and click the grid to place them.
2. **Shift-drag** from one component to another to connect them. Traffic flows in the arrow's direction.
3. Set the traffic dial and shape (steady, ramp, spikes, daily wave), press **Run**.
4. Watch the first thing turn red. The right panel names it, says why, and lists the techniques and curriculum days that address it.
5. Add or tune components until it holds. Then push the dial again.

Chaos: select a component and **Kill** it, or **Flush** a cache.

## Scenarios

**🎯 Scenarios** opens twelve graded challenges, from *Launch day* to *Region outage*. Each one fixes the traffic mix, scripts the load and the chaos (a cache flush, a provider outage, a zone going dark), and sets the targets:

- **Must**: availability and p99 latency. Pass both for ★.
- **Budget**: average monthly cost. ★★.
- **Bonus**: the scenario's twist (availability during the chaos, replica lag, processing lag, retry amplification). ★★★.

Design freely, then **Start test**. The design locks, the script plays, the checks update live. The debrief shows offered vs served traffic, p99 against its target, a strip of which component was the binding pressure over time, what gave way in order, and the trade-offs your design accepted.

After a test, **⏵ Replay in 3D** puts the scene back in the run: scrub the timeline, play it at 1×, 5× or 15×, and watch it break again with the binding pressure and the event log as they were at that second.

Each scenario keeps its own saved design, separate from the sandbox. Every scenario has a reference solution in `tests/scenarios.test.ts` that earns three stars, and a test that its starting design fails.

| Keys | |
|---|---|
| `Space` | run / pause |
| `Shift`-drag | connect |
| `C` | toggle connect mode |
| `Del` | remove selection |
| `F` | fit view |
| `R` | reset the simulation (keeps the design) |
| `Esc` | cancel / deselect |

Mouse: drag to pan, right-drag to rotate, scroll to zoom.

## Regions

The ground is three region plates: **us-east** in the middle, **eu-west** and **ap-south** across the water. A component's region is the plate it sits on, so drag it across to move it. Connections that cross an ocean show their round trip.

- Users pay a 30ms last mile to your entry point (10ms to a CDN edge), plus the round trip if it is in another region.
- **Clients** route to the nearest *healthy* entry point, and their **traffic share** splits users between regions.
- **🌩 Kill region** (inspector) takes a whole plate down for 60s.
- A database with a **standby region** promotes it after its failover time, and logs the writes that never made it across (RPO).

## The model

Traffic is a flow, not individual requests, so 1M rps costs the same to simulate as 10. The particles are a visual sample.

Every component is a queue: utilisation = load / capacity, latency climbs as utilisation approaches 1 (an M/M/c approximation, so a fleet queues like a pool), and above it a backlog builds, requests time out, and errors start. On top of that:

- **Worker pools and connection limits** (Little's law). A slow dependency fills the app's worker pool while its CPU sits idle, and the diagnosis blames the dependency, not the app.
- **Crashes**: app servers, workers and cache nodes under sustained CPU overload lose instances one at a time, and the survivors inherit the load.
- **Retries** amplify load on a failing system.
- **Autoscaling** reacts on CPU (or queue depth for workers) every 15s, with a 30s boot.
- **Load balancer health checks** route around dead backends. Without them, a dead instance's share of traffic fails.
- **Cache-aside** with warm-up: a cold or dead cache sends every read to the database at once.
- **Replicas** replay every primary write, and they lag when saturated.
- **Shards** are capped by their hottest key.
- **Network**: every connection costs its round trip, so a database across an ocean shows up in p99 and in how long app workers are held.
- **Queues** turn a spike into a backlog. Failed jobs wait out the **visibility timeout** and retry up to **max receives**, then land in the **dead-letter queue**, or are lost without one. Workers that are not **idempotent** duplicate work when an ambiguous failure is retried.
- **Circuit breakers** fail fast so a dependency can recover.
- **Search**: without a search index, searches hit the DB as LIKE queries costing 4× a normal query.

Capacities and prices are rough, order-of-magnitude numbers (`src/sim/profiles.ts`). They are for building intuition about shapes and ratios, not for capacity planning.

## Dependencies

`shepherd.js` is pinned to **11.2.0**, the last MIT-licensed release. From 12 on it is AGPL-3.0 or commercial. `npm audit` flags its `deepmerge` dependency for prototype poisoning; the tour only merges its own hard-coded step options, so that path is not reachable here.

## Layout

```
src/sim/       engine, component catalog, capacity profiles, diagnosis (no DOM, unit-tested)
src/scenarios/ scenario catalog, scripted runner, grading, progress
src/render/    Three.js scene and low-poly component models
src/state/     design store, persistence, templates
src/ui/        palette, toolbar, inspector, HUD
```
