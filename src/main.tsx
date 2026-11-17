import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatPanel } from './components/ChatPanel';
import { HighlightView } from './components/HighlightView';
import { PetView } from './components/PetView';
import { SettingsPanel } from './components/SettingsPanel';
import { resolveTheme, type CustomCharacterInfo } from '../shared/characters';
import { useSettingsStore } from './store/settingsStore';
import './styles/app.css';

/** One bundle, three windows — the main process picks the view through the URL hash. */
const view = window.location.hash.replace('#', '') || 'pet';
document.body.dataset.view = view;
// remote-chat/desktop_patch.py patches older renderers by regex. These marker strings tell it this build
// already has the shared conversation and the settings that follow saved values, so it leaves it alone.
document.documentElement.dataset.remoteChatReady = '__sharedChatV2 __visionSettingsSync';

// Window colours follow the chosen theme (or the character) in all three windows, live.
// User-made characters carry their own theme; the list is re-read when the character changes.
let customCharacters: CustomCharacterInfo[] = [];
let listedFor = '';
const applyTheme = (): void => {
  const s = useSettingsStore.getState().settings;
  document.documentElement.dataset.theme = resolveTheme(s.theme, s.character, customCharacters);
  if (s.character.startsWith('custom:') && listedFor !== s.character) {
    listedFor = s.character;
    void window.petAPI.listCharacters().then((list) => { customCharacters = list; applyTheme(); });
  }
};
applyTheme();
useSettingsStore.subscribe(applyTheme);

const root = createRoot(document.getElementById('root') as HTMLElement);
if (view === 'chat') root.render(<StrictMode><ChatPanel /></StrictMode>);
else if (view === 'settings') root.render(<StrictMode><SettingsPanel /></StrictMode>);
else if (view === 'highlight') root.render(<StrictMode><HighlightView /></StrictMode>);
else root.render(<PetView />);   // no StrictMode here: it would start the WebGL engine twice in dev
