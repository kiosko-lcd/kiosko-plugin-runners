/** For the tests: a saved command output or API answer from src/fixtures (see its README). */
import { readFileSync } from 'node:fs';

export const fixtureText = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
export const fixture = (name: string): unknown => JSON.parse(fixtureText(name));
