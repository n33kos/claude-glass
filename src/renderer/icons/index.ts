// The built-in apps' icons: full-tile artwork (its own color and a bold symbol), bundled into the
// shell as data URLs. A custom app's own icon.svg/png wins over these.
import agents from './agents.svg';
import browser from './browser.svg';
import conversation from './conversation.svg';
import diagram from './diagram.svg';
import diff from './diff.svg';
import files from './files.svg';
import html from './html.svg';
import image from './image.svg';
import markdown from './markdown.svg';
import settings from './settings.svg';
import tasks from './tasks.svg';
import terminal from './terminal.svg';
import tests from './tests.svg';

export const BUILTIN_ICONS: Record<string, string> = { agents, browser, conversation, diagram, diff, files, html, image, markdown, settings, tasks, terminal, tests };
