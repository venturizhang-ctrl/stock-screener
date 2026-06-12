/**
 * app.js — 利弗莫尔突破信号选股
 *
 * 两阶段筛选：
 * 阶段1（实时）：涨幅3%+、换手>2%、收盘>最高90% → 候选池（秒级）
 * 阶段2（验证）：拉日K线，检查突破N日高点+量比暴增 → 最终结果
 */

(function() {

    updateMarketStatus();

    // 可调参数
    var breakDays = 20;       // 突破N日高点
    var volRatioMin = 1.5;    // 量比阈值
    var changeMin = 3.0;      // 最低涨幅

    var debugLines = [];
    function debugLog(msg) {
        console.log(msg);
        debugLines.push(msg);
        var el = document.getElementById('debugText');
        if (el) el.textContent = debugLines.join('\n');
    }

    // 参数调整
    var dayOptions = [
        { id: 'optDays5', days: 5 },
        { id: 'optDays10', days: 10 },
        { id: 'optDays20', days: 20 },
        { id: 'optDays60', days: 60 }
    ];
    dayOptions.forEach(function(opt) {
        document.getElementById(opt.id).addEventListener('change', function() {
            if (this.checked) {
                breakDays = opt.days;
                document.getElementById('paramDays').textContent = breakDays;
            }
        });
    });

    var volOptions = [
        { id: 'optVol12', val: 1.2 },
        { id: 'optVol15', val: 1.5 },
        { id: 'optVol18', val: 1.8 },
        { id: 'optVol20', val: 2.0 }
    ];
    volOptions.forEach(function(opt) {
        document.getElementById(opt.id).addEventListener('change', function() {
            if (this.checked) volRatioMin = opt.val;
        });
    });

    // 开始
    document.getElementById('btnRefresh').addEventListener('click', runScreening);

    async function runScreening() {
        clearResults();

        if (!isTradingTime()) {
            var status = getMarketStatus();
            var ok = await myConfirm('当前' + status.text + '。实时筛选需交易时段，是否仍用最近收盘数据尝试？');
            if (!ok) return;
        }

        hideError(); setRefreshButton(true);
        debugLines = [];
        debugLog('=== 利弗莫尔突破信号 ===');
        debugLog('条件: 突破' + breakDays + '日高点 + 量比>' + volRatioMin.toFixed(1) + ' + 强势收盘');
        debugLog('时间: ' + new Date().toLocaleTimeString());

        try {
            // ====== 阶段1：实时扫描涨幅榜 ======
            showLoading('扫描涨幅榜...', '涨幅>' + changeMin + '% + 换手>2%');
            var candidates = await getRisingStocks(debugLog);
            debugLog('阶段1 候选: ' + candidates.length + '只 (涨幅>' + changeMin + '%)');

            if (candidates.length === 0) {
                debugLog('无候选，停止');
                showResults([]);
                finishRefresh();
                return;
            }

            // ====== 初筛：换手率 + 收盘强势 ======
            var preFiltered = [];
            for (var pi = 0; pi < candidates.length; pi++) {
                var s = candidates[pi];
                // 换手率 > 2%
                if (s.turnover < 2) continue;
                // 收盘价 > 今日最高 × 90%（收在强势区）
                var highPct = s.high > 0 ? s.price / s.high : 0;
                if (highPct < 0.88) continue;
                preFiltered.push(s);
            }
            debugLog('初筛(换手>2%+收盘强势): ' + candidates.length + '→' + preFiltered.length + '只');

            if (preFiltered.length === 0) {
                debugLog('初筛后无候选');
                showResults([]);
                finishRefresh();
                return;
            }

            // ====== 阶段2：拉日K线验证突破 ======
            showLoading('验证突破信号...', '候选' + preFiltered.length + '只');
            var finalStocks = [];
            var batchSize = 5;
            var processed = 0;
            var errors = 0;

            for (var bi = 0; bi < preFiltered.length; bi += batchSize) {
                var batch = preFiltered.slice(bi, bi + batchSize);

                var promises = batch.map(function(stock) {
                    return fetchDailyKline(stock.code).then(function(bars) {
                        return { stock: stock, bars: bars, error: null };
                    }).catch(function(e) {
                        return { stock: stock, bars: [], error: e.message };
                    });
                });

                var results = await Promise.all(promises);

                for (var ri = 0; ri < results.length; ri++) {
                    var r = results[ri];
                    if (r.error || r.bars.length < breakDays) {
                        if (r.error) errors++;
                        processed++;
                        continue;
                    }

                    var today = {
                        price: r.stock.price,
                        high: r.stock.high,
                        low: r.stock.low,
                        open: r.stock.open,
                        volume: r.stock.volume,
                        turnover: r.stock.turnover
                    };

                    var br = checkBreakout(r.bars, today, {
                        breakDays: breakDays,
                        volRatioMin: volRatioMin,
                        closeNearHigh: 0.90
                    });

                    if (br.pass) {
                        finalStocks.push({
                            code: r.stock.code,
                            name: r.stock.name,
                            price: r.stock.price,
                            change: r.stock.change,
                            turnover: r.stock.turnover,
                            nmc: r.stock.nmc,
                            breakResult: br
                        });
                    }
                    processed++;
                }

                var pct = Math.round(processed / preFiltered.length * 100);
                showLoading('验证突破...', processed + '/' + preFiltered.length +
                    ' (' + pct + '%) 确认' + finalStocks.length + '只');

                if (bi + batchSize < preFiltered.length) await delay(200);
            }

            debugLog('=== 完成 ===');
            debugLog('最终突破信号: ' + finalStocks.length + '只 (候选' + preFiltered.length + ', 失败' + errors + ')');
            finalStocks.forEach(function(s) {
                debugLog(s.code + ' ' + s.name + ' +' + s.change.toFixed(2) + '%');
                s.breakResult.details.forEach(function(d) { debugLog('  ' + d); });
            });

            showResults(finalStocks);
            finishRefresh();

        } catch (e) {
            debugLog('!! ' + (e.message || e));
            showError(e.message || '筛选失败');
            setRefreshButton(false);
            hideLoading();
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
        document.getElementById('resultBadge').textContent = '突破' + breakDays + '日高点';
        renderStockList('listResult', stocks);
    }

    function finishRefresh() {
        hideLoading(); setRefreshButton(false);
        var now = new Date();
        var ts = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0') + ':' + now.getSeconds().toString().padStart(2, '0');
        updateLastRefresh(ts); updateMarketStatus();
    }

})();
