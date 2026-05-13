/**
 * app.js — 主控逻辑（实时 + 历史）
 */

(function() {

    updateMarketStatus();

    var debugLines = [];
    function debugLog(msg) {
        console.log(msg);
        debugLines.push(msg);
        var el = document.getElementById('debugText');
        if (el) el.textContent = debugLines.join('\n');
    }

    var isHistoryMode = false;

    // 模式切换
    document.getElementById('btnRealTime').addEventListener('click', function() {
        isHistoryMode = false;
        this.classList.add('active');
        document.getElementById('btnHistory').classList.remove('active');
        document.getElementById('historyDateBar').style.display = 'none';
        document.getElementById('emptyMain').textContent = '点击"开始筛选"查看符合条件的股票';
        updateParamsBar(false);
        document.querySelector('.progress-bar').style.display = '';
    });

    document.getElementById('btnHistory').addEventListener('click', function() {
        isHistoryMode = true;
        this.classList.add('active');
        document.getElementById('btnRealTime').classList.remove('active');
        document.getElementById('historyDateBar').style.display = 'flex';
        document.getElementById('emptyMain').textContent = '选择日期后点击"开始筛选"';
        // 日期限制：本月和上个月
        var now = new Date();
        var dateInput = document.getElementById('historyDate');
        var firstDayLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        var yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
        dateInput.min = fmtDate(firstDayLastMonth);
        dateInput.max = fmtDate(yesterday);
        if (!dateInput.value || dateInput.value > dateInput.max || dateInput.value < dateInput.min) {
            dateInput.value = fmtDate(yesterday);
        }
        document.getElementById('historyDateHint').textContent = '';
        updateParamsBar(true);
        document.querySelector('.progress-bar').style.display = 'none';
    });

    // 日期变更校验交易日
    document.getElementById('historyDate').addEventListener('change', function() {
        var d = new Date(this.value + 'T00:00:00');
        var day = d.getDay();
        if (isNaN(d.getTime())) return;
        if (day === 0 || day === 6) {
            document.getElementById('historyDateHint').textContent = '⚠ ' + this.value + ' 是周末，非交易日，请重新选择';
            document.getElementById('historyDateHint').style.color = '#E65100';
        } else {
            document.getElementById('historyDateHint').textContent = this.value + ' 周一至周五（如遇节假日请自判）';
            document.getElementById('historyDateHint').style.color = '#888';
        }
    });

    document.getElementById('btnRefresh').addEventListener('click', function() {
        if (isHistoryMode) runHistoryScreening();
        else runRealTimeScreening();
    });

    // ===== 实时筛选 =====
    async function runRealTimeScreening() {
        // 清空旧结果
        clearResults();

        if (!isTradingTime()) {
            var status = getMarketStatus();
            if (!confirm('当前' + status.text + '，将显示最近交易日收盘数据。是否继续？')) return;
        }

        hideError(); resetProgress(); setRefreshButton(true);
        document.getElementById('debugArea').style.display = 'block';
        debugLines = []; debugLog('=== 实时筛选 ==='); debugLog('时间: ' + new Date().toLocaleTimeString());

        var step1 = [], step2 = [], step3 = null, step4 = null, step5 = [], step6 = [];

        try {
            updateStep(1, null, 'active'); debugLog('--- 步骤1: 新浪分页 ---');
            var pn = 1, stop = false, total = 0;
            while (pn <= 60 && !stop) {
                showLoading('步骤1/6：获取第' + pn + '页(新浪)...');
                try { var pd = await fetchSinaPage(pn); } catch (e) { debugLog('新浪第' + pn + '页失败'); pn++; continue; }
                if (!pd || pd.length === 0) { stop = true; break; }
                var ps = pd.map(convertSinaStock); total += ps.length;
                var m = ps.filter(function(s) { return s.f3 >= 3 && s.f3 <= 5; });
                step1 = step1.concat(m);
                debugLog('第' + pn + '页: ' + ps.length + '只, 累计匹配=' + step1.length);
                if (ps[ps.length - 1].f3 < 3) stop = true;
                pn++; if (!stop) await delay(300);
            }
            updateStep(1, step1.length, 'completed');
            if (!step1.length) { finishEarly('步骤1无结果'); return; }

            updateStep(2, null, 'active');
            showLoading('步骤2/6：批量查询量比(腾讯)...');
            var volMap = await fetchVolumeRatios(step1, debugLog);
            step1.forEach(function(s) { var v = volMap[s.f12]; if (v !== undefined) s.f10 = v; });
            step2 = filterByVolumeRatio(step1);
            debugLog('步骤2: ' + step2.length + '只'); updateStep(2, step2.length, 'completed');

            step3 = filterByTurnover(step2);
            debugLog('步骤3: ' + step3.length + '只'); updateStep(3, step3.length, 'completed');

            step4 = filterByMarketCap(step3);
            debugLog('步骤4: ' + step4.length + '只'); updateStep(4, step4.length, 'completed');
            if (!step4.length) { finishEarly('前4步后无结果'); return; }

            updateStep(5, null, 'active');
            for (var i = 0; i < step4.length; i++) {
                var s = step4[i]; showLoading('步骤5/6：均线 (' + (i + 1) + '/' + step4.length + ')...');
                try {
                    var bars = await fetchTencentKline(s.f12);
                    var mr = checkBullishMA(bars, s.f2);
                    if (mr.pass) { step5.push(s); debugLog('  ' + s.f12 + ' ' + s.f14 + ' ✓'); }
                    else debugLog('  ' + s.f12 + ' ' + s.f14 + ' ✗ ' + mr.reason);
                } catch (e) { debugLog('  ' + s.f12 + ' ✗ K线失败'); }
                if (i < step4.length - 1) await delay(300);
            }
            debugLog('步骤5: ' + step5.length + '只'); updateStep(5, step5.length, 'completed');
            showStep5(step5);
            if (!step5.length) { finishEarly(''); return; }

            updateStep(6, null, 'active'); debugLog('--- 步骤6: 分时均价 ---');
            for (var j = 0; j < step5.length; j++) {
                var s5 = step5[j]; showLoading('步骤6/6：分时 (' + (j + 1) + '/' + step5.length + ')...');
                try {
                    var mb = await fetchTencentMinute(s5.f12);
                    var vr = checkAboveVWAP(mb);
                    if (vr.pass) { step6.push(s5); debugLog('  ' + s5.f12 + ' ' + s5.f14 + ' ✓ (' + (vr.rate * 100).toFixed(0) + '%)'); }
                    else debugLog('  ' + s5.f12 + ' ' + s5.f14 + ' ✗ (' + (vr.rate * 100).toFixed(0) + '%)');
                } catch (e) { debugLog('  ' + s5.f12 + ' ✗ 分时异常'); }
                if (j < step5.length - 1) await delay(300);
            }
            updateStep(6, step6.length, 'completed');
            showStep6(step6);
            debugLog('=== 完成 ==='); finishRefresh();

        } catch (e) { debugLog('!! ' + (e.message || e)); showError(e.message || '失败'); setRefreshButton(false); hideLoading(); }
    }

    // ===== 历史查询（用收盘数据）=====
    async function runHistoryScreening() {
        // 清空旧结果
        clearResults();

        var dateInput = document.getElementById('historyDate').value;
        if (!dateInput) { showError('请先选择日期'); return; }

        // 校验交易日
        var dCheck = new Date(dateInput + 'T00:00:00');
        if (dCheck.getDay() === 0 || dCheck.getDay() === 6) {
            showError(dateInput + ' 是周末，非交易日，请重新选择');
            return;
        }

        var targetDate = dateInput;

        // 校验是否为交易日（通过查询贵州茅台日线验证）
        showLoading('校验交易日...', '');
        var isTradeDay = false;
        try {
            var checkBars = await fetchHistoricalDailyLight('600519');
            for (var cdi = 0; cdi < checkBars.length; cdi++) {
                if (checkBars[cdi].date === targetDate) { isTradeDay = true; break; }
            }
        } catch (e) {}
        hideLoading();
        if (!isTradeDay) {
            showError(targetDate + ' 非交易日（节假日无行情数据），请重新选择');
            return;
        }

        var cacheKey = 'aq_hist_' + targetDate;

        // 检查缓存
        var cached = localStorage.getItem(cacheKey);
        if (cached) {
            try {
                var cacheData = JSON.parse(cached);
                if (cacheData.step6) {
                    setRefreshButton(true);
                    showLoading('正在查询目标日期...', targetDate);
                    document.getElementById('debugArea').style.display = 'block';
                    // 恢复首次查询的调试信息+（缓存）标记
                    debugLines = (cacheData.debugLines || []).slice();
                    debugLines.push('--- 以上为缓存数据（' + new Date(cacheData.ts).toLocaleTimeString() + '）---');
                    var el2 = document.getElementById('debugText');
                    if (el2) el2.textContent = debugLines.join('\n');
                    await delay(1000);
                    hideLoading();
                    showStep6(cacheData.step6);
                    var now2 = new Date();
                    updateLastRefresh(now2.getHours().toString().padStart(2,'0') + ':' + now2.getMinutes().toString().padStart(2,'0') + ':' + now2.getSeconds().toString().padStart(2,'0'));
                    updateMarketStatus();
                    setRefreshButton(false);
                    document.getElementById('emptyState').style.display = 'none';
                    return;
                }
            } catch (e) { localStorage.removeItem(cacheKey); }
        }

        hideError(); resetProgress(); setRefreshButton(true);
        document.getElementById('debugArea').style.display = 'block';
        debugLines = []; debugLog('=== 历史查询 ==='); debugLog('目标日期: ' + targetDate + ' (收盘数据)');

        var step1 = [], step2 = [], step3 = null, step4 = [], step5 = [], step6 = [];
        var dailyCache = {};

        try {
            // 获取全部股票列表（含名称和市值）
            showLoading('获取A股列表...', '');
            var allInfoList = await getAllStockInfo(debugLog);
            debugLog('获取到 ' + allInfoList.length + ' 只股票');

            // === 优化：先按市值筛选（数据已有，秒出），减少日线查询量 ===
            var infoMap = {};
            for (var im = 0; im < allInfoList.length; im++) {
                var info = allInfoList[im];
                infoMap[info.code] = info;
            }

            // 步骤4先做：流通市值 50-200亿（纯内存筛选，秒出）
            updateStep(4, null, 'active');
            var capFiltered = allInfoList.filter(function(info) {
                var capYi = info.nmc / 100000000;
                return capYi >= 50 && capYi <= 200;
            });
            var capFilteredCodes = capFiltered.map(function(info) { return info.code; });
            debugLog('步骤4(市值50-200亿)先筛: ' + allInfoList.length + '→' + capFilteredCodes.length + '只');

            // 没有通过市值筛选的，直接标记后续步骤为0
            updateStep(4, capFilteredCodes.length, 'completed');

            // === 只对市值筛选后的股票查日线 ===
            showLoading('获取历史日线数据...', '共' + capFilteredCodes.length + '只（已跳过市值筛选）');
            updateStep(1, null, 'active');
            var batchSize = 10; // 并发数提高到10
            var processed = 0;

            for (var bi = 0; bi < capFilteredCodes.length; bi += batchSize) {
                var batch = capFilteredCodes.slice(bi, bi + batchSize);
                var promises = batch.map(function(code) {
                    return fetchHistoricalDailyLight(code).then(function(bars) {
                        return { code: code, bars: bars };
                    }).catch(function() { return { code: code, bars: [] }; });
                });

                var results = await Promise.all(promises);
                for (var ri = 0; ri < results.length; ri++) {
                    var r = results[ri];
                    var targetBar = null, prevClose = null, targetIdx = -1;
                    for (var bi2 = 0; bi2 < r.bars.length; bi2++) {
                        if (r.bars[bi2].date === targetDate) {
                            targetBar = r.bars[bi2];
                            targetIdx = bi2;
                            if (bi2 > 0) prevClose = r.bars[bi2 - 1].close;
                            break;
                        }
                    }
                    if (targetBar && prevClose && prevClose > 0) {
                        dailyCache[r.code] = { bars: r.bars, targetBar: targetBar, targetIdx: targetIdx };
                        var info = infoMap[r.code];
                        var changePct = (targetBar.close - prevClose) / prevClose * 100;
                        if (changePct >= 3 && changePct <= 5) {
                            var stock = makeHistoryStock(r.code, targetBar, prevClose, changePct);
                            stock._bars = r.bars; stock._prevClose = prevClose;
                            stock.f14 = info ? info.name : r.code;
                            stock.f21 = info ? info.nmc : 0;
                            stock.f20 = info ? info.mktcap : 0;
                            step1.push(stock);
                        }
                    }
                    processed++;
                }
                var pct = Math.round(processed / capFilteredCodes.length * 100);
                showLoading('获取日线数据...', processed + '/' + capFilteredCodes.length + ' (' + pct + '%)');
                if (bi + batchSize < capFilteredCodes.length) await delay(80);
            }
            debugLog('步骤1(涨幅3-5%): ' + step1.length + '只（从' + capFilteredCodes.length + '只市值筛选后查询）');
            updateStep(1, step1.length, 'completed');
            if (!step1.length) { finishEarly('该日期无3-5%涨幅股票'); return; }

            // 步骤2: 量比近似（当日成交量/5日均量）
            updateStep(2, null, 'active');
            step1.forEach(function(s) {
                var dc = dailyCache[s.f12];
                var tb = dc.targetBar, bars = dc.bars, ti = dc.targetIdx;
                if (ti >= 5) {
                    var sumVol = 0;
                    for (var vi = ti - 5; vi < ti; vi++) sumVol += bars[vi].volume;
                    s.f10 = sumVol > 0 ? tb.volume / (sumVol / 5) : 0;
                }
            });
            step2 = step1.filter(function(s) { return s.f10 > 1.45; });
            debugLog('步骤2(量比>1.45): ' + step2.length + '只');
            updateStep(2, step2.length, 'completed');

            // 步骤3: 换手率近似
            step3 = step2.filter(function(s) {
                var tb = dailyCache[s.f12].targetBar;
                var circShares = s.f21 / (tb.close || 1);
                s.f8 = circShares > 0 ? (tb.volume * 100) / circShares : 0;
                return s.f8 >= 5 && s.f8 <= 10;
            });
            debugLog('步骤3(换手5-10%): ' + step3.length + '只');
            updateStep(3, step3.length, 'completed');

            // 步骤4结果即步骤3（市值已在最前面筛选）
            step4 = step3;
            debugLog('步骤4(市值): ' + step4.length + '只（已在前置步骤完成）');
            if (!step4.length) { finishEarly('前4步后无结果'); return; }

            // 步骤5: 均线多头
            updateStep(5, null, 'active');
            debugLog('--- 步骤5: 均线分析(' + step4.length + '只) ---');
            for (var si = 0; si < step4.length; si++) {
                var s5s = step4[si];
                showLoading('步骤5/6：均线 (' + (si + 1) + '/' + step4.length + ')...');
                var dc5 = dailyCache[s5s.f12];
                var klineBars = dc5.bars.slice(0, dc5.targetIdx + 1).map(function(b) { return { date: b.date, close: b.close }; });
                var maResult = checkBullishMA(klineBars, dc5.targetBar.close);
                if (maResult.pass) {
                    step5.push(s5s);
                    debugLog('  ' + s5s.f12 + ' ' + s5s.f14 + ' ✓');
                } else {
                    debugLog('  ' + s5s.f12 + ' ' + s5s.f14 + ' ✗ ' + maResult.reason);
                }
                if (si < step4.length - 1) await delay(200);
            }
            debugLog('步骤5(均线多头): ' + step5.length + '只');
            updateStep(5, step5.length, 'completed');
            // 历史模式不展示步骤5结果
            if (!step5.length) { finishEarly(''); return; }

            // 步骤6: 收盘价在日线上半区（收盘数据替代均价线）
            updateStep(6, null, 'active');
            debugLog('--- 步骤6: 收盘强势(' + step5.length + '只) ---');
            debugLog('规则: 收盘价 > (最高+最低)/2 且 收盘 > 开盘');
            for (var s6i = 0; s6i < step5.length; s6i++) {
                var s6s = step5[s6i];
                var tb = dailyCache[s6s.f12].targetBar;
                var midPrice = (tb.high + tb.low) / 2;
                if (tb.close > tb.open && tb.close > midPrice) {
                    step6.push(s6s);
                    debugLog('  ' + s6s.f12 + ' ' + s6s.f14 + ' ✓ 收' + tb.close.toFixed(2) + ' > 中' + midPrice.toFixed(2));
                } else {
                    debugLog('  ' + s6s.f12 + ' ' + s6s.f14 + ' ✗ 收' + tb.close.toFixed(2) + ' 开' + tb.open.toFixed(2) + ' 中' + midPrice.toFixed(2));
                }
            }
            debugLog('步骤6(收盘强势): ' + step6.length + '只');
            updateStep(6, step6.length, 'completed');

            // 获取次交易日涨跌幅
            if (step6.length > 0) {
                showLoading('获取次交易日数据...');
                debugLog('--- 获取次交易日9:30-10:00最高涨幅 ---');
                for (var ni = 0; ni < step6.length; ni++) {
                    var ns = step6[ni];
                    try {
                        var peak = await fetchNextDayPeak(ns.f12, targetDate);
                        var dc = dailyCache[ns.f12];
                        var tb = dc.targetBar;
                        // 次交易日收盘涨跌幅（从日线cache取）
                        var nextBar = null;
                        for (var nj = 0; nj < dc.bars.length - 1; nj++) {
                            if (dc.bars[nj].date === targetDate) { nextBar = dc.bars[nj + 1]; break; }
                        }
                        if (nextBar) {
                            // 检查次交易日是否为今天且未收盘
                            var nowStr = new Date().toISOString().split('T')[0];
                            if (nextBar.date === nowStr && isTradingTime()) {
                                ns.nextDayCloseChange = null; // 标记为未收盘
                            } else {
                                ns.nextDayCloseChange = (nextBar.close - tb.close) / tb.close * 100;
                            }
                        }
                        // 次交易日9:30-10:00最高涨幅
                        if (peak && peak.price > 0) {
                            ns.nextDayChange = (peak.price - tb.close) / tb.close * 100;
                            ns.nextDayMethod = peak.method;
                            var errInfo = peak.error ? ' 新浪失败:' + peak.error : '';
                            debugLog('  ' + ns.f12 + ' 次日' + peak.date + ' 峰值' + peak.price.toFixed(2) + ' 前收' + tb.close.toFixed(2) + ' 最高' + ns.nextDayChange.toFixed(2) + '% 收盘' + (ns.nextDayCloseChange || 0).toFixed(2) + '% (' + peak.method + ')' + errInfo);
                        }
                    } catch (e) {}
                    if (ni < step6.length - 1) await delay(100);
                }
            }

            showStep6(step6);
            // 保存到缓存（仅当次交易日已收盘）
            var canCache = true;
            var nowStr2 = new Date().toISOString().split('T')[0];
            for (var ci = 0; ci < step6.length; ci++) {
                if (step6[ci].nextDayCloseChange === null) { canCache = false; break; }
            }
            if (canCache && step6.length > 0) {
                try {
                    localStorage.setItem(cacheKey, JSON.stringify({ date: targetDate, ts: Date.now(), step6: step6, debugLines: debugLines }));
                    debugLog('结果已缓存(' + cacheKey + ')');
                } catch (e) {}
            } else if (!canCache) {
                debugLog('次交易日未收盘，跳过缓存');
            }
            debugLog('=== 历史查询完成 ===');
            finishRefresh();

        } catch (e) { debugLog('!! ' + (e.message || e)); showError(e.message || '失败'); setRefreshButton(false); hideLoading(); }
    }

    // ===== 辅助 =====

    function makeHistoryStock(code, targetBar, prevClose, changePct) {
        return {
            f2: targetBar.close, f3: changePct, f8: null, f10: null,
            f12: code,
            f13: (code.toString().startsWith('6') || code.toString().startsWith('9')) ? 1 : 0,
            f14: code, f20: 0, f21: 0
        };
    }

    function updateParamsBar(historyMode) {
        var body = document.getElementById('paramsBody');
        if (historyMode) {
            body.innerHTML =
                '<div class="param-row"><span class="param-step">①</span>流通市值 <b>50亿 ~ 200亿</b>（优先筛选）</div>' +
                '<div class="param-row"><span class="param-step">②</span>涨幅 <b>3% ~ 5%</b>（收盘数据近似）</div>' +
                '<div class="param-row"><span class="param-step">③</span>量比 <b>> 1.45</b>（日总成交量/5日均量）</div>' +
                '<div class="param-row"><span class="param-step">④</span>换手率 <b>5% ~ 10%</b>（日总换手近似）</div>' +
                '<div class="param-row"><span class="param-step">⑤</span>均线多头 <b>MA5 > MA10 > MA20</b> 且上方无压力</div>' +
                '<div class="param-row"><span class="param-step">⑥</span>收盘强势 <b>收盘>开盘 且 收盘>中位价</b></div>';
        } else {
            body.innerHTML =
                '<div class="param-row"><span class="param-step">①</span>涨幅 <b>3% ~ 5%</b></div>' +
                '<div class="param-row"><span class="param-step">②</span>量比 <b>> 1.45</b></div>' +
                '<div class="param-row"><span class="param-step">③</span>换手率 <b>5% ~ 10%</b></div>' +
                '<div class="param-row"><span class="param-step">④</span>流通市值 <b>50亿 ~ 200亿</b></div>' +
                '<div class="param-row"><span class="param-step">⑤</span>均线多头 <b>MA5 > MA10 > MA20</b> 且上方无压力</div>' +
                '<div class="param-row"><span class="param-step">⑥</span>100%时间在均价线上方 <b>（剔除开盘2min）</b></div>';
        }
    }

    function fmtDate(d) {
        return d.getFullYear() + '-' +
            String(d.getMonth() + 1).padStart(2, '0') + '-' +
            String(d.getDate()).padStart(2, '0');
    }

    function clearResults() {
        // 强制清空旧结果
        document.getElementById('resultStep5').style.display = 'none';
        document.getElementById('resultStep6').style.display = 'none';
        document.getElementById('listStep5').innerHTML = '';
        document.getElementById('listStep6').innerHTML = '';
        document.getElementById('countStep5').textContent = '0';
        document.getElementById('countStep6').textContent = '0';
        // 也清空步骤5、6步骤计数
        document.querySelector('.step[data-step="5"] .step-count').textContent = '';
        document.querySelector('.step[data-step="6"] .step-count').textContent = '';
    }

    function showStep5(stocks) {
        showResultSection('resultStep5', true);
        updateResultCount('countStep5', stocks.length);
        renderStockList('listStep5', stocks);
    }

    function showStep6(stocks) {
        showResultSection('resultStep6', true);
        updateResultCount('countStep6', stocks.length);
        renderStockList('listStep6', stocks);
    }

    function finishEarly(msg) {
        if (msg) debugLog(msg);
        updateStep(5, 0, 'completed'); updateStep(6, 0, 'completed');
        if (!isHistoryMode) showStep5([]);
        showStep6([]);
        finishRefresh();
    }

    function finishRefresh() {
        hideLoading(); setRefreshButton(false);
        var now = new Date();
        var ts = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0') + ':' + now.getSeconds().toString().padStart(2, '0');
        updateLastRefresh(ts); updateMarketStatus();
    }

})();
