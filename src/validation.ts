export function hasControlCharacters(value: string) {
  return [...value].some((character) => character.charCodeAt(0) < 32)
}
