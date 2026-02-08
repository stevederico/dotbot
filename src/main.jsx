/**
 * Application entry point — mounts the Skateboard shell with dotBot routes.
 *
 * @see {@link https://github.com/stevederico/skateboard|Skateboard Docs}
 */
import './assets/styles.css';
import { createSkateboardApp } from '@stevederico/skateboard-ui/App';
import constants from './constants.json';
import ChatView from './components/ChatView.jsx';

/** @type {Array<{path: string, element: JSX.Element}>} */
const appRoutes = [
  { path: 'chat', element: <ChatView /> }
];

createSkateboardApp({
  constants,
  appRoutes,
  defaultRoute: 'chat'
});
