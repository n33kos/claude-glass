declare module '*.css';
declare module '*.svg' { const url: string; export default url; } // bundled as a data URL
