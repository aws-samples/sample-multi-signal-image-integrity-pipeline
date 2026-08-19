// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import * as tokens from '@cloudscape-design/design-tokens';

export interface PipelineStep {
  label: string;
}

/**
 * Horizontal numbered stepper (onboarding-progress style): numbered circles
 * joined by connector lines. Completed steps show a check, the active step is
 * filled with the brand color, pending steps are neutral. Built with
 * Cloudscape design tokens so light/dark modes both work.
 */
export default function PipelineProgress({
  title,
  steps,
  activeIndex,
}: {
  title: string;
  steps: PipelineStep[];
  activeIndex: number; // -1 = not started; steps.length = all complete
}) {
  return (
    <div
      style={{
        background: tokens.colorBackgroundContainerContent,
        border: `1px solid ${tokens.colorBorderDividerDefault}`,
        borderRadius: tokens.borderRadiusContainer,
        padding: `${tokens.spaceScaledL} ${tokens.spaceScaledXl}`,
      }}
    >
      <div
        style={{
          fontSize: tokens.fontSizeHeadingM,
          fontWeight: 700,
          color: tokens.colorTextHeadingDefault,
          marginBottom: tokens.spaceScaledL,
        }}
      >
        {title}
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-start' }}>
        {steps.map((step, i) => {
          const isDone = i < activeIndex;
          const isActive = i === activeIndex;
          const circleBg = isDone || isActive ? tokens.colorBackgroundControlChecked : 'transparent';
          const circleBorder = isDone || isActive ? tokens.colorBackgroundControlChecked : tokens.colorBorderControlDefault;
          const circleFg = isDone || isActive ? tokens.colorTextButtonPrimaryDefault : tokens.colorTextBodySecondary;
          const labelColor = isActive
            ? tokens.colorTextLinkDefault
            : isDone
              ? tokens.colorTextBodyDefault
              : tokens.colorTextBodySecondary;
          return (
            <div key={step.label} style={{ display: 'flex', flex: i === steps.length - 1 ? '0 0 auto' : 1, minWidth: 0 }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 96 }}>
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: circleBg,
                    border: `2px solid ${circleBorder}`,
                    color: circleFg,
                    fontWeight: 700,
                    flexShrink: 0,
                    transition: 'background 0.3s, border-color 0.3s',
                  }}
                >
                  {isDone ? '✓' : i + 1}
                </div>
                <div
                  style={{
                    marginTop: tokens.spaceScaledXs,
                    fontSize: tokens.fontSizeBodyS,
                    fontWeight: isActive ? 700 : 400,
                    color: labelColor,
                    textAlign: 'center',
                    lineHeight: 1.3,
                  }}
                >
                  {step.label}
                </div>
              </div>
              {i < steps.length - 1 && (
                <div
                  style={{
                    flex: 1,
                    height: 2,
                    marginTop: 15,
                    marginLeft: -28,
                    marginRight: -28,
                    background: isDone ? tokens.colorBackgroundControlChecked : tokens.colorBorderDividerDefault,
                    transition: 'background 0.3s',
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
