import Shepherd from 'shepherd.js';
import 'shepherd.js/dist/css/shepherd.css';

const MAIN_KEY = 'sds:tour:main:v1';
const SCENARIO_KEY = 'sds:tour:scenario:v1';

type Step = {
  id: string;
  title: string;
  text: string;
  element?: string;
  on?: 'top' | 'bottom' | 'left' | 'right' | 'bottom-start';
};

const MAIN_STEPS: Step[] = [
  {
    id: 'welcome',
    title: 'System Design Simulator',
    text: `<p>Build a system out of components, push traffic through it, and watch which part breaks first. Then fix it and push harder.</p>
      <p>The point is not the components. It is learning to name the <strong>binding pressure</strong>: the one limit that is hurting you right now.</p>
      <p class="tour-muted">Two minutes. Use the arrow keys or the buttons.</p>`,
  },
  {
    id: 'palette',
    title: 'Components',
    element: '#palette',
    on: 'right',
    text: `<p>Click a component, then click the grid to place it. Or drag it straight onto the grid.</p>
      <p>Hold <kbd>Shift</kbd> while placing to drop several in a row. <kbd>Esc</kbd> stops.</p>`,
  },
  {
    id: 'canvas',
    title: 'Wire it up',
    element: '#hints',
    on: 'bottom-start',
    text: `<p><kbd>Shift</kbd>-drag from one component to another to connect them. Traffic flows the way the arrow points.</p>
      <p>Drag a component to move it. Drag empty space to pan, right-drag to rotate, scroll to zoom. <kbd>Del</kbd> removes whatever is selected.</p>`,
  },
  {
    id: 'paths',
    title: 'Split traffic by path',
    text: `<p>Connect an <strong>API Gateway</strong> to more than one service and each connection shows a <span class="tour-pill">70%</span> pill: the share of the gateway's traffic that goes down that path, like <code>/search</code> or <code>/checkout</code>.</p>
      <p>Click a connection to change its <strong>Path share</strong>. Each service then gets its own load, scales on its own, and fails on its own.</p>`,
  },
  {
    id: 'regions',
    title: 'Regions are places',
    text: `<p>The ground is three regions: <strong>us-east</strong> in the middle, <strong>eu-west</strong> and <strong>ap-south</strong> across the water. Zoom out to see them.</p>
      <p>Drag a component onto another plate to move it there. Crossing an ocean costs a round trip (75 to 200ms), and the connection shows it.</p>`,
  },
  {
    id: 'templates',
    title: 'Start from something',
    element: '#toolbar select',
    on: 'bottom',
    text: `<p>Eleven starter designs, from a day-one monolith to a retry storm. Some hold, some are built to break. The description says which.</p>`,
  },
  {
    id: 'traffic',
    title: 'Turn up the traffic',
    element: '.traffic',
    on: 'bottom',
    text: `<p>The dial sets peak requests per second, from 1 to a million, on a log scale. The shape decides how it arrives: steady, ramping, spiking, or a daily wave.</p>`,
  },
  {
    id: 'run',
    title: 'Run it',
    element: '.run-button',
    on: 'bottom',
    text: `<p><kbd>Space</kbd> runs and pauses. Speed it up to 10× to see minutes pass in seconds. <kbd>R</kbd> resets the simulation and keeps your design.</p>
      <p>Dots on the connections are traffic: <span class="tour-dot" style="background:#38bdf8"></span>reads, <span class="tour-dot" style="background:#fb923c"></span>writes, <span class="tour-dot" style="background:#a78bfa"></span>static, <span class="tour-dot" style="background:#ef4444"></span>errors.</p>`,
  },
  {
    id: 'metrics',
    title: 'The four dials',
    element: '#metrics',
    on: 'top',
    text: `<p>What your users feel: traffic served, errors, requests turned away, median and p99 latency, how much retries are multiplying the load, and what it all costs per month.</p>`,
  },
  {
    id: 'diagnosis',
    title: 'Binding pressure',
    element: '#diagnosis',
    on: 'left',
    text: `<p>The first thing to read when something goes red. It names the component at its limit and why, traces symptoms back to their cause, and says what binds next.</p>
      <p>Before anything breaks, it estimates the traffic where it will.</p>`,
  },
  {
    id: 'inspector',
    title: 'Tune and break things',
    element: '#inspector',
    on: 'left',
    text: `<p>Click a component. Its health and four key numbers sit at the top. <strong>Live</strong> has the details, <strong>Settings</strong> has the dials: instances, size, cache hit ratio, retries, standby region.</p>
      <p>Then break it on purpose: <strong>Kill</strong> it, <strong>Flush</strong> a cache, or take down a whole region.</p>`,
  },
  {
    id: 'events',
    title: 'What happened',
    element: '#events',
    on: 'left',
    text: `<p>Crashes, autoscaling, breakers opening, failovers and dead-lettered jobs, in order.</p>`,
  },
  {
    id: 'learn',
    title: 'Learn by doing',
    element: '.learn-button',
    on: 'bottom',
    text: `<p>Thirteen short lessons, from the four dials to services and regions. Each one sets up a live system, tells you what to change and what to watch, and ticks off each step as you do it.</p>
      <p>Every lesson ends with exercises you solve freehand.</p>`,
  },
  {
    id: 'scenarios',
    title: 'When you want a question',
    element: '.scenarios-button',
    on: 'bottom',
    text: `<p>Twelve graded scenarios: fixed traffic, scripted chaos, real targets. Pass for one star, stay on budget for two, hit the bonus for three.</p>
      <p>After each test you get a debrief and a 3D replay of the run.</p>`,
  },
  {
    id: 'help',
    title: 'That is it',
    element: '.help-button',
    on: 'bottom',
    text: `<p>Load a template, push the dial until something turns red, read the binding pressure, fix it, push again.</p>
      <p>New here? Start with <strong>Learn</strong>. This button brings the tour back.</p>`,
  },
];

const SCENARIO_STEPS: Step[] = [
  {
    id: 'brief',
    title: 'The question',
    element: '#brief',
    on: 'left',
    text: `<p>The brief, the facts you cannot change, and the targets. <strong>Must</strong> targets earn the first star, <strong>Budget</strong> the second, <strong>Bonus</strong> the third.</p>
      <p>Anything marked 🔒 is part of the scenario. Hints are there when you are stuck.</p>`,
  },
  {
    id: 'practice',
    title: 'Practise first',
    text: `<p>Build and run freely with the traffic dial as long as you like. Nothing is graded until you start the test.</p>`,
  },
  {
    id: 'start',
    title: 'Then take the test',
    element: '#brief .actions',
    on: 'left',
    text: `<p><strong>Start test</strong> locks the design and plays the scripted traffic and chaos. The checks update live. At the end, the debrief shows what gave way, the trade-offs you accepted, and a 3D replay.</p>`,
  },
];

function build(steps: Step[], key: string): Shepherd.Tour {
  const tour = new Shepherd.Tour({
    useModalOverlay: true,
    exitOnEsc: true,
    keyboardNavigation: true,
    defaultStepOptions: {
      classes: 'sds-tour',
      cancelIcon: { enabled: true },
      scrollTo: false,
      modalOverlayOpeningPadding: 6,
      modalOverlayOpeningRadius: 10,
    },
  });

  steps.forEach((step, index) => {
    const first = index === 0;
    const last = index === steps.length - 1;
    tour.addStep({
      id: step.id,
      title: step.title,
      text: step.text,
      attachTo: step.element ? { element: step.element, on: step.on ?? 'bottom' } : undefined,
      buttons: [
        ...(first ? [{ text: 'Skip', secondary: true, action: () => tour.cancel() }] : [{ text: 'Back', secondary: true, action: () => tour.back() }]),
        { text: last ? 'Done' : `Next  ${index + 1}/${steps.length}`, action: () => (last ? tour.complete() : tour.next()) },
      ],
    });
  });

  const remember = () => {
    try {
      localStorage.setItem(key, 'seen');
    } catch {
      // Without storage the tour shows again next visit; nothing else depends on it.
    }
  };
  tour.on('complete', remember);
  tour.on('cancel', remember);
  return tour;
}

function seen(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'seen';
  } catch {
    return true;
  }
}

export function startMainTour(): void {
  Shepherd.activeTour?.cancel();
  build(MAIN_STEPS, MAIN_KEY).start();
}

export function startMainTourOnce(): void {
  if (!seen(MAIN_KEY)) startMainTour();
}

export function startScenarioTourOnce(): void {
  if (seen(SCENARIO_KEY) || Shepherd.activeTour) return;
  build(SCENARIO_STEPS, SCENARIO_KEY).start();
}
