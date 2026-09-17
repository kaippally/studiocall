import { useEffect, useState, type ComponentType } from 'react';
import ReactDOM from 'react-dom/client';
import { StudioCallSpeakerOverlay } from './components/StudioCallSpeakerOverlay';
import { StudioCallChatOverlay } from './components/StudioCallChatOverlay';
import { StudioCallInfoCardOverlay } from './components/StudioCallInfoCardOverlay';
import { OverlayLayerContext, type LayerStyle } from './lib/overlayLayerContext';
import { ws } from './ws';
import './index.css';

// An OBS browser source: `overlay.html?layer=speakers|chat|card`, sized to the source. Every other
// query parameter is a layer style (`color=%23f59e0b&speakerAnim=blink&titleSize=28`) — numbers
// and true/false are read as such, anything else as text.

const LAYERS: Record<string, ComponentType> = {
  speakers: StudioCallSpeakerOverlay,
  chat: StudioCallChatOverlay,
  card: StudioCallInfoCardOverlay,
};

const params = new URLSearchParams(location.search);
const Layer = LAYERS[params.get('layer') ?? 'speakers'];

const style: LayerStyle = {};
for (const [k, v] of params) {
  if (k === 'layer') continue;
  (style as Record<string, unknown>)[k] = v === 'true' ? true : v === 'false' ? false : v !== '' && Number.isFinite(Number(v)) ? Number(v) : v;
}

document.documentElement.style.background = 'transparent';
document.body.style.background = 'transparent';
ws.connect();

function Overlay() {
  const [size, setSize] = useState({ width: innerWidth, height: innerHeight });
  useEffect(() => {
    const onResize = () => setSize({ width: innerWidth, height: innerHeight });
    addEventListener('resize', onResize);
    return () => removeEventListener('resize', onResize);
  }, []);
  if (!Layer) return <div className="p-4 text-white">Unknown layer — use ?layer=speakers, chat or card.</div>;
  return (
    <OverlayLayerContext.Provider value={{ x: 0, y: 0, ...size, ...style, sink: 'obs' }}>
      <div className="relative overflow-hidden" style={{ width: size.width, height: size.height }}>
        <Layer />
      </div>
    </OverlayLayerContext.Provider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Overlay />);
