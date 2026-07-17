function sameOrder(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

export function shuffledOrderAvoiding(ids, disallowedOrder, random = Math.random) {
  const shuffled = [...ids];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  if (shuffled.length > 1 && sameOrder(shuffled, disallowedOrder)) {
    shuffled.push(shuffled.shift());
  }
  return shuffled;
}

export function shuffledMatchingRightIds(block, random = Math.random) {
  const correctRightOrder = block.left.map((leftItem) =>
    block.pairs.find((pair) => pair.leftId === leftItem.id)?.rightId
  );
  return shuffledOrderAvoiding(
    block.right.map((item) => item.id),
    correctRightOrder,
    random,
  );
}
