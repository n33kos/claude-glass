import type { AppViewProps } from '../../sdk/react';
import type { HtmlState } from './index';

// Claude-authored code runs here: opaque-origin sandbox, served by main with a strict CSP.
export default function HtmlView({ id, state }: AppViewProps<HtmlState>) {
  return (
    <iframe
      className="htmlview"
      key={state.updatedAt}
      src={`glass-html://${encodeURIComponent(id)}/?v=${state.updatedAt}`}
      sandbox="allow-scripts"
      title={`${id} canvas`}
    />
  );
}
