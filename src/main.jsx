/**
 * Application entry point — mounts the Skateboard shell with dotBot routes.
 *
 * @see {@link https://github.com/stevederico/skateboard|Skateboard Docs}
 */
/**
 * Application entry point — mounts the Skateboard shell with dotBot routes.
 *
 * Uses a custom Layout override to render ChatSidebar (conversation list)
 * instead of the default static page sidebar.
 *
 * @see {@link https://github.com/stevederico/skateboard|Skateboard Docs}
 */
import './assets/styles.css';
import { createSkateboardApp } from '@stevederico/skateboard-ui/App';
import constants from './constants.json';
import ChatView from './components/ChatView.jsx';
import Layout from './components/Layout.jsx';

/** @type {Array<{path: string, element: JSX.Element}>} */
const appRoutes = [
  { path: 'chat', element: <ChatView /> }
];

createSkateboardApp({
  constants,
  appRoutes,
  defaultRoute: 'chat',
  overrides: { layout: Layout },
});
