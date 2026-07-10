/// Swap the item at `index` one slot toward `dir` (-1 up, 1 down); a no-op
/// copy when the target would fall outside the list — 1:1 port of
/// apps/web/src/components/account/menu-order.ts's `moveItem`. Never mutates
/// `list` (a fresh array is always returned).
public func menuMoveItem<T>(_ list: [T], index: Int, dir: Int) -> [T] {
    let target = index + dir
    guard target >= 0, target < list.count else { return list }
    var next = list
    next.swapAt(index, target)
    return next
}
