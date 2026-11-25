{{- define "skillhub.name" -}}{{ .Release.Name }}{{- end -}}

{{- define "skillhub.labels" -}}
app.kubernetes.io/name: skillhub
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "skillhub.selector" -}}
app.kubernetes.io/name: skillhub
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "skillhub.secretName" -}}
{{- if .Values.existingSecret -}}{{ .Values.existingSecret }}{{- else -}}{{ .Release.Name }}-secrets{{- end -}}
{{- end -}}

{{/* A volume is needed for the SQLite file or for uploads on disk. */}}
{{- define "skillhub.needsVolume" -}}
{{- if or (eq .Values.database.type "sqlite") (eq .Values.storage.type "disk") -}}true{{- end -}}
{{- end -}}

{{- define "skillhub.replicas" -}}
{{- if or (eq .Values.database.type "sqlite") (eq .Values.storage.type "disk") -}}1{{- else -}}{{ .Values.replicaCount }}{{- end -}}
{{- end -}}

{{- define "skillhub.host" -}}{{ (urlParse .Values.baseUrl).host }}{{- end -}}
