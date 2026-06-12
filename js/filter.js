/**
 * filter.js — 筛选逻辑
 * 条件：连续N周K线向上（每周收盘 > 前周收盘）
 */
function checkConsecutiveWeeklyUp(weeklyBars, weeks) {
    var result = { pass: false, details: [], weeklyChanges: [] };

    if (!weeklyBars || weeklyBars.length < weeks + 1) {
        result.details.push('周K线不足' + (weeks + 1) + '条(' + (weeklyBars ? weeklyBars.length : 0) + ')');
        return result;
    }

    var lastBars = weeklyBars.slice(-(weeks + 1));

    for (var i = 1; i < lastBars.length; i++) {
        var prev = lastBars[i - 1];
        var curr = lastBars[i];
        var change = (curr.close - prev.close) / prev.close * 100;
        result.weeklyChanges.push(change);

        if (curr.close > prev.close) {
            result.details.push(
                curr.date + ' 收' + curr.close.toFixed(2) +
                ' > 前周' + prev.close.toFixed(2) +
                ' (+' + change.toFixed(2) + '%) ✓'
            );
        } else {
            result.details.push(
                curr.date + ' 收' + curr.close.toFixed(2) +
                ' ≤ 前周' + prev.close.toFixed(2) +
                ' (' + change.toFixed(2) + '%) ✗'
            );
            return result;
        }
    }

    result.pass = true;
    return result;
}
