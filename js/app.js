/**
 * app.js — 主控
 * 分步筛选：第1周→第2周→…→第N周
 */

(function() {

    updateMarketStatus();

    var selectedWeeks = 3;
    var weekCounts = {};

    var debugLines = [];
    function debugLog(msg) {
        console.log(msg);
        debugLines.push(msg);
        var el = document.getElementById('debugText');
        if (el) el.textContent = debugLines.join('\n');
    }

    resetParamsBar();

    // 周数切换
    document.querySelectorAll('.week-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            selectedWeeks = parseInt(this.getAttribute('data-weeks'));
            updateWeekSelector(selectedWeeks);
            resetParamsBar();
        });
    });

    // 开始筛选
    document.getElementById('btnRefresh').addEventListener('click', runScreening);

    async function runScreening() {
        clearResults();
        resetParamsBar();

        if (!isTradingTime()) {
            var status = getMarketStatus();
            var ok = await myConfirm('当前' + status.text + '，将使用最近收盘数据。是否继续？');
            if (!ok) return;
        }

        hideError(); setRefreshButton(true);
        debugLines = [];
        debugLog('=== 分步筛选 连续' + selectedWeeks + '周向上 ===');
        debugLog('时间: ' + new Date().toLocaleTimeString());

        try {
            // ====== 获取股票列表 ======
            showLoading('获取A股列表...', '');
            var allInfoList = await getAllStockInfo(debugLog);
            debugLog('获取到 ' + allInfoList.length + ' 只股票');

            var infoMap = {};
            allInfoList.forEach(function(info) { infoMap[info.code] = info; });

            var candidates = allInfoList;
            var batchSize = 5;

            // ====== 第1周：拉取所有候选的周K线 ======
            showLoading('第1周筛选...', '候选' + candidates.length + '只');
            var passed1 = [];
            var errors1 = 0;

            for (var bi = 0; bi < candidates.length; bi += batchSize) {
                var batch = candidates.slice(bi, bi + batchSize);

                var promises = batch.map(function(item) {
                    return fetchWeeklyKline(item.code).then(function(bars) {
                        return { item: item, bars: bars, error: null };
                    }).catch(function(e) {
                        return { item: item, bars: [], error: e.message };
                    });
                });

                var results = await Promise.all(promises);

                for (var ri = 0; ri < results.length; ri++) {
                    var r = results[ri];
                    if (r.error || r.bars.length < 2) { errors1++; continue; }

                    var bars = r.bars;
                    var currBar = bars[bars.length - 1];
                    var prevBar = bars[bars.length - 2];

                    if (currBar.close > prevBar.close) {
                        var info = infoMap[r.item.code];
                        r.item.f2 = currBar.close;
                        r.item.f14 = info ? info.name : r.item.code;
                        r.item.nmcYi = info ? (info.nmc / 100000000).toFixed(0) : '--';
                        r.item._nmc = info ? info.nmc : 0; // 流通市值(元)，用于算换手率
                        r.item._bars = bars;
                        passed1.push(r.item);
                    }
                }

                var pct = Math.round((bi + batch.length) / candidates.length * 100);
                showLoading('第1周筛选...', (bi + batch.length) + '/' + candidates.length +
                    ' (' + pct + '%) 通过' + passed1.length + '只');

                if (bi + batchSize < candidates.length) await delay(300);
            }

            weekCounts[1] = passed1.length;
            updateParamsCount(1, passed1.length);
            debugLog('第1周: ' + candidates.length + '→' + passed1.length + '只 (失败' + errors1 + ')');
            candidates = passed1;

            // ====== 第2~N周 ======
            for (var week = 2; week <= selectedWeeks; week++) {
                var passed = [];

                for (var ci = 0; ci < candidates.length; ci++) {
                    var c = candidates[ci];
                    var bars = c._bars;

                    if (bars.length >= week + 1) {
                        var currBar2 = bars[bars.length - week];
                        var prevBar2 = bars[bars.length - week - 1];
                        if (currBar2.close > prevBar2.close) {
                            passed.push(c);
                        }
                    }
                }

                weekCounts[week] = passed.length;
                updateParamsCount(week, passed.length);
                debugLog('第' + week + '周: ' + candidates.length + '→' + passed.length + '只');
                candidates = passed;

                if (candidates.length === 0) break;
            }

            // ====== 组装最终结果（含换手率）======
            debugLog('=== 完成 === 最终' + candidates.length + '只');

            var finalStocks = [];
            for (var fi = 0; fi < candidates.length; fi++) {
                var c = candidates[fi];
                var bars = c._bars;
                var weeklyResult = { pass: true, details: [], weeklyChanges: [], weeklyTurnovers: [] };

                for (var w = 1; w <= selectedWeeks; w++) {
                    var curr = bars[bars.length - w];
                    var prev = bars[bars.length - w - 1];
                    if (curr && prev) {
                        var change = (curr.close - prev.close) / prev.close * 100;
                        weeklyResult.weeklyChanges.unshift(change);
                        weeklyResult.details.unshift(
                            curr.date + ' 收' + curr.close.toFixed(2) +
                            ' > 前周' + prev.close.toFixed(2) + ' (+' + change.toFixed(2) + '%)'
                        );

                        // 周换手率 = 周成交量 / 流通股数 × 100%
                        // 流通股数 ≈ 流通市值 / 当周收盘价
                        var turnover = 0;
                        if (c._nmc > 0 && curr.close > 0 && curr.volume > 0) {
                            var shares = c._nmc / curr.close;
                            turnover = (curr.volume / shares) * 100;
                        }
                        weeklyResult.weeklyTurnovers.unshift(turnover);
                    }
                }

                finalStocks.push({
                    f12: c.code, f14: c.f14, f2: c.f2,
                    nmcYi: c.nmcYi, weeklyResult: weeklyResult
                });
            }

            showResults(finalStocks);
            finishRefresh();

        } catch (e) {
            debugLog('!! ' + (e.message || e));
            showError(e.message || '筛选失败');
            setRefreshButton(false);
            hideLoading();
        }
    }

    // ====== 辅助 ======

    function resetParamsBar() {
        weekCounts = {};
        for (var w = 1; w <= 5; w++) {
            var el = document.getElementById('paramCnt' + w);
            if (el) el.textContent = '--';
        }
        document.getElementById('paramRow4').style.display = (selectedWeeks >= 4) ? 'flex' : 'none';
        document.getElementById('paramRow5').style.display = (selectedWeeks >= 5) ? 'flex' : 'none';
    }

    function updateParamsCount(week, count) {
        var el = document.getElementById('paramCnt' + week);
        if (el) el.textContent = count;
        if (week === 1) {
            document.getElementById('paramRow4').style.display = (selectedWeeks >= 4) ? 'flex' : 'none';
            document.getElementById('paramRow5').style.display = (selectedWeeks >= 5) ? 'flex' : 'none';
        }
    }

    function clearResults() {
        showResultSection('resultArea', false);
        document.getElementById('listResult').innerHTML = '';
        document.getElementById('countResult').textContent = '0';
    }

    function showResults(stocks) {
        showResultSection('resultArea', true);
        updateResultCount('countResult', stocks.length);
        document.getElementById('resultBadge').textContent = '连续' + selectedWeeks + '周向上';
        renderStockList('listResult', stocks);
    }

    function finishRefresh() {
        hideLoading(); setRefreshButton(false);
        var now = new Date();
        var ts = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0') + ':' + now.getSeconds().toString().padStart(2, '0');
        updateLastRefresh(ts); updateMarketStatus();
    }

})();
