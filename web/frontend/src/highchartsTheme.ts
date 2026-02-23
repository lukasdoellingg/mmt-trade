import type { Options } from 'highcharts';

export const VELO_CHART: Partial<Options> = {
  chart: {
    backgroundColor: 'transparent',
    style: { fontFamily: "'IBM Plex Mono', 'Roboto Mono', monospace" },
    spacing: [8, 8, 8, 8],
    animation: false,
  },
  title: { text: undefined },
  subtitle: { text: undefined },
  credits: { enabled: false },
  legend: { enabled: false },
  time: { useUTC: true },
  xAxis: {
    lineColor: '#1e1e2a',
    tickColor: '#1e1e2a',
    gridLineColor: '#14141e',
    gridLineWidth: 0,
    labels: { style: { color: '#5a6a7a', fontSize: '9px' } },
    crosshair: { color: 'rgba(90,106,122,0.3)', width: 1 },
    tickLength: 4,
  },
  yAxis: {
    lineWidth: 0,
    tickWidth: 0,
    gridLineColor: '#14141e',
    gridLineWidth: 1,
    labels: { style: { color: '#5a6a7a', fontSize: '9px' }, align: 'right', x: -6 },
    title: { text: undefined },
    opposite: true,
  },
  tooltip: {
    backgroundColor: 'rgba(15,15,20,0.95)',
    borderColor: '#2a2a3a',
    borderRadius: 4,
    style: { color: '#c8d8e8', fontSize: '10px' },
    shared: true,
    useHTML: true,
    shadow: false,
    headerFormat: '<span style="font-size:9px;color:#7a8a9a">{point.key}</span><br/>',
  },
  plotOptions: {
    series: {
      animation: false,
      lineWidth: 1.5,
      marker: { enabled: false, radius: 2, states: { hover: { radius: 3 } } },
      states: { hover: { lineWidth: 2 } },
    },
    column: {
      borderWidth: 0,
      borderRadius: 1,
      pointPadding: 0.05,
      groupPadding: 0.1,
    },
    area: {
      fillOpacity: 0.15,
      lineWidth: 1.5,
    },
    line: {
      marker: { enabled: false },
    },
  },
};
