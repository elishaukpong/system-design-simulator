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

1. Load a template (or start blank), or pick components from the left and click the grid to place them.
2. **Shift-drag** from one component to another to connect them. Traffic flows in the arrow's direction.
3. Set the traffic dial and shape (steady, ramp, spikes, daily wave), press **Run**.
4. Watch the first thing turn red. The right panel names it, says why, and lists the techniques and curriculum days that address it.
5. Add or tune components until it holds. Then push the dial again.

Chaos: select a component and **Kill** it, or **Flush** a cache.

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

## The model

Traffic is a flow, not individual requests, so 1M rps costs the same to simulate as 10. The particles are a visual sample.

Every component is a queue: utilisation = load / capacity, latency climbs as utilisation approaches 1, and above it a backlog builds, requests time out, and errors start. On top of that:

- **Worker pools and connection limits** (Little's law). A slow dependency fills the app's worker pool while its CPU sits idle, and the diagnosis blames the dependency, not the app.
- **Crashes**: app servers, workers and cache nodes under sustained CPU overload lose instances one at a time, and the survivors inherit the load.
- **Retries** amplify load on a failing system.
- **Autoscaling** reacts on CPU (or queue depth for workers) every 15s, with a 30s boot.
- **Load balancer health checks** route around dead backends. Without them, a dead instance's share of traffic fails.
- **Cache-aside** with warm-up: a cold or dead cache sends every read to the database at once.
- **Replicas** replay every primary write, and they lag when saturated.
- **Shards** are capped by their hottest key.
- **Queues** turn a spike into a backlog. **Circuit breakers** fail fast so a dependency can recover.
- **Search**: without a search index, searches hit the DB as LIKE queries costing 4× a normal query.

Capacities and prices are rough, order-of-magnitude numbers (`src/sim/profiles.ts`). They are for building intuition about shapes and ratios, not for capacity planning.

## Layout

```
src/sim/       engine, component catalog, capacity profiles, diagnosis (no DOM, unit-tested)
src/render/    Three.js scene and low-poly component models
src/state/     design store, persistence, templates
src/ui/        palette, toolbar, inspector, HUD
```
