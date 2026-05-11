export function getRollImageSource(src: string, sequence: number) {
	if (!src) return src;
	if (!sequence) return src;

	const [pathAndQuery, hash = ''] = src.split('#', 2);
	const separator = pathAndQuery.includes('?') ? '&' : '?';

	return `${pathAndQuery}${separator}obsUtilsRoll=${sequence}${hash ? `#${hash}` : ''}`;
}
