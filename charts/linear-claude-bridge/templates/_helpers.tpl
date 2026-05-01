{{/*
Expand the name of the chart.
*/}}
{{- define "linear-claude-bridge.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Create a fully-qualified app name. Truncated at 63 chars (DNS-1123 limit).
*/}}
{{- define "linear-claude-bridge.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Chart label.
*/}}
{{- define "linear-claude-bridge.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels applied to every resource the chart renders.
*/}}
{{- define "linear-claude-bridge.labels" -}}
helm.sh/chart: {{ include "linear-claude-bridge.chart" . }}
{{ include "linear-claude-bridge.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
Selector labels — must be stable across upgrades, so they exclude version
and chart fields.
*/}}
{{- define "linear-claude-bridge.selectorLabels" -}}
app.kubernetes.io/name: {{ include "linear-claude-bridge.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Name of the secret holding the Linear/Anthropic credentials. Resolves
to either the user-supplied existingSecret or the chart-managed one.
*/}}
{{- define "linear-claude-bridge.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- include "linear-claude-bridge.fullname" . -}}
{{- end -}}
{{- end -}}

{{/*
Name of the ServiceAccount the deployment runs under.
*/}}
{{- define "linear-claude-bridge.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "linear-claude-bridge.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}
