module.exports = function chunk(arr, size) {
  if (size < 1) {
    throw new RangeError('Size must be at least 1');
  }
  const result = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}