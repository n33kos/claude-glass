import type { ViewProps } from '../../renderer/viewTypes';
import type { HtmlState } from './index';

// Claude-authored code runs here: opaque-origin sandbox, served by main with a strict CSP.
export function HtmlView({ id, state }: ViewProps<HtmlState>) {
  return (
    <iframe
      className="htmlview"
      key={state.updatedAt}
      src={`canvas-html://${encodeURIComponent(id)}/?v=${state.updatedAt}`}
      sandbox="allow-scripts"
      title={`${id} canvas`}
    />
  );
}
