const release = /^(\d+)\.(\d+)\.(\d+)$/u;
const parts = version => release.exec(version ?? '')?.slice(1).map(Number);

export function isAtLeast(version, minimum) {
  const observed = parts(version);
  if (!observed) return false;
  const required = parts(minimum);
  const difference = observed.map((part, index) => part - required[index]).find(Boolean) ?? 0;
  return difference >= 0;
}
