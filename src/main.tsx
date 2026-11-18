import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell, isPage } from './components/AppShell';
import { HighlightView } from './components/HighlightView';
import { PetView } from './components/PetView';
import { resolveTheme, type CustomCharacterInfo } from '../shared/characters';
import { useSettingsStore } from './store/settingsStore';
import './styles/app.css';
import './styles/harness.css';
import './styles/shell.css';

/** One bundle, three windows — the main process picks the view through the URL hash. */
// "#chat" or "#chat:settings" = the main window (opened on a page); "#settings" is the old name of its settings page.
const [rawView, rawPage] = (window.location.hash.replace('#', '') || 'pet').split(':');
const view = rawView === 'settings' ? 'chat' : rawView ?? 'pet';
const startPage = rawView === 'settings' ? 'settings' : isPage(rawPage) ? rawPage : 'chat';
document.body.dataset.view = view;

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
if (view === 'chat') root.render(<StrictMode><AppShell initialPage={startPage} /></StrictMode>);
else if (view === 'highlight') root.render(<StrictMode><HighlightView /></StrictMode>);
else root.render(<PetView />);   // no StrictMode here: it would start the WebGL engine twice in dev
